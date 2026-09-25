//! A diagram view: an architecture diagram you edit to change the code.
//!
//! The diagram is an ordinary oxdraw file — Mermaid, with oxdraw's layout
//! block and its `%% OXDRAW CODE <node> <path>` lines saying where each box
//! lives in the code — so oxdraw can open the same file, and so can anything
//! else that reads Mermaid.
//!
//! An edit here is a request, not a render. Adding a box, drawing an arrow,
//! renaming or removing one: each is held as a pending change and previewed
//! against the file, and applying them writes the new diagram and hands an
//! agent a description of what changed and where the touched code is. The
//! agent makes the code match. The diagram is the spec.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use oxdraw::{
    align_geometry, edge_identifier, split_source_and_overrides, Diagram, Edge,
    EdgeArrowDirection, EdgeKind, LayoutOverrides, NodeStyleOverride, LAYOUT_BLOCK_END,
    LAYOUT_BLOCK_START,
};
use serde::{Deserialize, Serialize};

/// One pending change, as the web UI holds it until you apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Edit {
    AddNode { id: String, label: String },
    AddEdge {
        from: String,
        to: String,
        #[serde(default)]
        label: String,
    },
    Rename { id: String, label: String },
    RemoveNode { id: String },
    RemoveEdge { from: String, to: String },
}

/// Where a box lives in the code, as the diagram records it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRef {
    pub file: String,
    pub lines: Option<String>,
    pub symbol: Option<String>,
}

impl CodeRef {
    fn describe(&self) -> String {
        let mut out = self.file.clone();
        if let Some(lines) = &self.lines {
            out.push_str(&format!(" lines {lines}"));
        }
        if let Some(symbol) = &self.symbol {
            out.push_str(&format!(" ({symbol})"));
        }
        out
    }
}

/// `%% OXDRAW CODE <node> <path> [line:<a>-<b>] [def:<symbol>]`.
///
/// Read here rather than through oxdraw's own reader, which indexes past the
/// end of a line with no path on it; a half-typed line should not take the
/// daemon down.
pub fn code_refs(source: &str) -> HashMap<String, CodeRef> {
    let mut out = HashMap::new();
    for line in source.lines() {
        let mut parts = line.split_whitespace();
        if (parts.next(), parts.next(), parts.next()) != (Some("%%"), Some("OXDRAW"), Some("CODE")) {
            continue;
        }
        let (Some(node), Some(file)) = (parts.next(), parts.next()) else {
            continue;
        };
        let mut code = CodeRef { file: file.into(), lines: None, symbol: None };
        for part in parts {
            if let Some(lines) = part.strip_prefix("line:") {
                code.lines = Some(lines.into());
            } else if let Some(symbol) = part.strip_prefix("def:") {
                code.symbol = Some(symbol.into());
            }
        }
        out.insert(node.to_string(), code);
    }
    out
}

/// A diagram file, read and split into its parts.
pub struct DiagramFile {
    pub source: String,
    pub diagram: Diagram,
    pub overrides: LayoutOverrides,
    pub code: HashMap<String, CodeRef>,
}

impl DiagramFile {
    pub fn parse(source: &str) -> Result<Self> {
        let (definition, overrides) = split_source_and_overrides(source)?;
        let diagram = Diagram::parse(&definition).context("the diagram is not valid Mermaid")?;
        Ok(DiagramFile {
            source: source.to_string(),
            diagram,
            overrides,
            code: code_refs(source),
        })
    }

    pub fn read(path: &Path) -> Result<Self> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        Self::parse(&source).with_context(|| format!("reading {}", path.display()))
    }
}

/// A Mermaid label cannot hold the characters that delimit it.
fn clean_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| !matches!(c, '"' | '[' | ']' | '(' | ')' | '{' | '}' | '|' | '\n'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !id.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// A box sized the way oxdraw sizes one, by letting oxdraw parse it.
fn sized_node(id: &str, label: &str) -> Result<oxdraw::Node> {
    let probe = Diagram::parse(&format!("graph TD\n    {id}[{label}]\n"))?;
    probe.nodes.get(id).cloned().context("oxdraw did not read the new box")
}

/// Apply pending edits in order. Every one is checked against the diagram
/// as it stands at that point, so a list that only makes sense in another
/// order is refused rather than half-applied.
pub fn apply(diagram: &mut Diagram, edits: &[Edit]) -> Result<()> {
    for edit in edits {
        match edit {
            Edit::AddNode { id, label } => {
                anyhow::ensure!(valid_id(id), "`{id}` cannot name a box: letters, digits and _");
                anyhow::ensure!(!diagram.nodes.contains_key(id), "there is already a box called {id}");
                let label = clean_label(label);
                anyhow::ensure!(!label.is_empty(), "a box needs a label");
                diagram.nodes.insert(id.clone(), sized_node(id, &label)?);
                diagram.order.push(id.clone());
            }
            Edit::AddEdge { from, to, label } => {
                for end in [from, to] {
                    anyhow::ensure!(diagram.nodes.contains_key(end), "there is no box called {end}");
                }
                anyhow::ensure!(
                    !diagram.edges.iter().any(|e| &e.from == from && &e.to == to),
                    "{from} already points at {to}"
                );
                let label = clean_label(label);
                diagram.edges.push(Edge {
                    from: from.clone(),
                    to: to.clone(),
                    label: (!label.is_empty()).then_some(label),
                    kind: EdgeKind::Solid,
                    arrow: EdgeArrowDirection::Forward,
                });
            }
            Edit::Rename { id, label } => {
                let label = clean_label(label);
                anyhow::ensure!(!label.is_empty(), "a box needs a label");
                let node = diagram.nodes.get_mut(id).with_context(|| format!("there is no box called {id}"))?;
                let sized = sized_node(id, &label)?;
                node.label = sized.label;
                node.width = sized.width;
                node.height = sized.height;
            }
            Edit::RemoveNode { id } => {
                anyhow::ensure!(diagram.remove_node(id), "there is no box called {id}");
            }
            Edit::RemoveEdge { from, to } => {
                let found = diagram
                    .edges
                    .iter()
                    .find(|e| &e.from == from && &e.to == to)
                    .map(edge_identifier)
                    .with_context(|| format!("{from} does not point at {to}"))?;
                diagram.remove_edge_by_identifier(&found);
            }
        }
    }
    Ok(())
}

// -- what the view draws -----------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBox {
    pub id: String,
    pub label: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub code: Option<CodeRef>,
    /// `added` or `renamed`, when a pending edit touches it.
    pub change: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeLine {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub added: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drawn {
    /// oxdraw's own rendering, pending changes coloured in.
    pub svg: String,
    pub width: f32,
    pub height: f32,
    /// Where every box is, so a click on the picture can find it.
    pub nodes: Vec<NodeBox>,
    pub edges: Vec<EdgeLine>,
    /// Boxes a pending edit takes away, which the picture can no longer show.
    pub removed: Vec<String>,
}

const PLAIN: (&str, &str, &str) = ("#fffdfa", "#81786d", "#28231f");
const ADDED: (&str, &str, &str) = ("#e3eee8", "#2f886c", "#1e5c48");
const RENAMED: (&str, &str, &str) = ("#f5ead7", "#b66a0a", "#7a4706");

/// oxdraw keeps a point's coordinates private and serializes them, so this
/// reads them the one way it exposes.
fn centre(point: &oxdraw::Point) -> Option<(f32, f32)> {
    let value = serde_json::to_value(point).ok()?;
    Some((value.get("x")?.as_f64()? as f32, value.get("y")?.as_f64()? as f32))
}

/// Draw the file with pending edits applied.
pub fn draw(file: &DiagramFile, edits: &[Edit]) -> Result<Drawn> {
    let mut diagram = file.diagram.clone();
    apply(&mut diagram, edits)?;

    let before: HashSet<&String> = file.diagram.nodes.keys().collect();
    let mut change: HashMap<String, &str> = HashMap::new();
    for edit in edits {
        match edit {
            Edit::AddNode { id, .. } => {
                change.insert(id.clone(), "added");
            }
            Edit::Rename { id, .. } if before.contains(id) => {
                change.entry(id.clone()).or_insert("renamed");
            }
            _ => {}
        }
    }
    let old_edges: HashSet<(&str, &str)> = file
        .diagram
        .edges
        .iter()
        .map(|e| (e.from.as_str(), e.to.as_str()))
        .collect();

    let mut overrides = file.overrides.clone();
    let nodes: HashSet<String> = diagram.nodes.keys().cloned().collect();
    let edge_ids: HashSet<String> = diagram.edges.iter().map(edge_identifier).collect();
    overrides.prune(&nodes, &edge_ids);
    // Boxes the file does not style take oxroute's paper rather than
    // oxdraw's default yellow, so a change is the only colour on the page.
    for id in &diagram.order {
        overrides.node_styles.entry(id.clone()).or_insert_with(|| NodeStyleOverride {
            fill: Some(PLAIN.0.into()),
            stroke: Some(PLAIN.1.into()),
            text: Some(PLAIN.2.into()),
            ..Default::default()
        });
    }
    for (id, kind) in &change {
        let (fill, stroke, text) = if *kind == "added" { ADDED } else { RENAMED };
        overrides.node_styles.insert(
            id.clone(),
            NodeStyleOverride {
                fill: Some(fill.into()),
                stroke: Some(stroke.into()),
                text: Some(text.into()),
                ..Default::default()
            },
        );
    }

    let svg = diagram.render_svg("#fbf9f6", Some(&overrides))?;
    let layout = diagram.layout(Some(&overrides))?;
    let geometry = align_geometry(
        &layout.final_positions,
        &layout.final_routes,
        &diagram.edges,
        &diagram.subgraphs,
        &diagram.nodes,
    )?;

    let boxes = diagram
        .order
        .iter()
        .filter_map(|id| {
            let node = diagram.nodes.get(id)?;
            let (x, y) = centre(geometry.positions.get(id)?)?;
            Some(NodeBox {
                id: id.clone(),
                label: node.label.clone(),
                x: x - node.width / 2.0,
                y: y - node.height / 2.0,
                width: node.width,
                height: node.height,
                code: file.code.get(id).cloned(),
                change: change.get(id).map(|c| c.to_string()),
            })
        })
        .collect();
    let edges = diagram
        .edges
        .iter()
        .map(|e| EdgeLine {
            from: e.from.clone(),
            to: e.to.clone(),
            label: e.label.clone(),
            added: !old_edges.contains(&(e.from.as_str(), e.to.as_str())),
        })
        .collect();
    let mut removed: Vec<String> = file
        .diagram
        .nodes
        .keys()
        .filter(|id| !diagram.nodes.contains_key(*id))
        .cloned()
        .collect();
    removed.sort();

    Ok(Drawn {
        svg,
        width: geometry.width,
        height: geometry.height,
        nodes: boxes,
        edges,
        removed,
    })
}

/// The file with edits applied, in the shape oxdraw writes: the Mermaid,
/// then the code map for every box still there, then the layout block.
pub fn rewrite(file: &DiagramFile, edits: &[Edit]) -> Result<String> {
    let mut diagram = file.diagram.clone();
    apply(&mut diagram, edits)?;
    let mut out = diagram.to_definition();

    let keep_code: BTreeSet<String> = file
        .code
        .keys()
        .filter(|id| diagram.nodes.contains_key(*id))
        .cloned()
        .collect();
    let code_lines: Vec<&str> = file
        .source
        .lines()
        .filter(|line| {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some("%%"), Some("OXDRAW"), Some("CODE"), Some(node)) => keep_code.contains(node),
                (Some("%%"), Some("OXDRAW"), Some("META"), _) => true,
                _ => false,
            }
        })
        .collect();
    if !code_lines.is_empty() {
        out.push('\n');
        for line in code_lines {
            out.push_str(line.trim());
            out.push('\n');
        }
    }

    let mut overrides = file.overrides.clone();
    let nodes: HashSet<String> = diagram.nodes.keys().cloned().collect();
    let edge_ids: HashSet<String> = diagram.edges.iter().map(edge_identifier).collect();
    overrides.prune(&nodes, &edge_ids);
    if !overrides.is_empty() {
        out.push('\n');
        out.push_str(LAYOUT_BLOCK_START);
        out.push('\n');
        for line in serde_json::to_string_pretty(&overrides)?.lines() {
            out.push_str("%% ");
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(LAYOUT_BLOCK_END);
        out.push('\n');
    }
    Ok(out)
}

/// Write the file, all at once: a reader never sees half a diagram.
pub fn write(path: &Path, contents: &str) -> Result<()> {
    let temporary = path.with_extension(format!(
        "{}.oxroute-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("mmd")
    ));
    std::fs::write(&temporary, contents)
        .with_context(|| format!("writing {}", temporary.display()))?;
    std::fs::rename(&temporary, path).with_context(|| format!("writing {}", path.display()))
}

/// Which boxes an edit list touches: every agent put on a change is linked
/// to them, so the diagram can show who is on what.
pub fn touched(edits: &[Edit]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for edit in edits {
        match edit {
            Edit::AddNode { id, .. } | Edit::Rename { id, .. } | Edit::RemoveNode { id } => {
                out.insert(id.clone());
            }
            Edit::AddEdge { from, to, .. } | Edit::RemoveEdge { from, to } => {
                out.insert(from.clone());
                out.insert(to.clone());
            }
        }
    }
    out
}

/// A name for the agent that makes a change: the first thing it is for.
pub fn title(file: &DiagramFile, edits: &[Edit]) -> String {
    let label = |id: &str| {
        file.diagram.nodes.get(id).map(|n| n.label.clone()).unwrap_or_else(|| {
            edits
                .iter()
                .find_map(|e| match e {
                    Edit::AddNode { id: added, label } if added == id => Some(clean_label(label)),
                    _ => None,
                })
                .unwrap_or_else(|| id.to_string())
        })
    };
    let first = match edits.first() {
        Some(Edit::AddNode { label: l, .. }) => format!("Add {}", clean_label(l)),
        Some(Edit::AddEdge { from, to, .. }) => format!("Wire {} to {}", label(from), label(to)),
        Some(Edit::Rename { id, label: l }) => format!("Rename {} to {}", label(id), clean_label(l)),
        Some(Edit::RemoveNode { id }) => format!("Remove {}", label(id)),
        Some(Edit::RemoveEdge { from, to }) => format!("Unwire {} from {}", label(from), label(to)),
        None => return "Diagram change".into(),
    };
    match edits.len() {
        1 => first,
        n => format!("{first}, and {} more", n - 1),
    }
}

/// What an agent is told when the diagram changes: what moved, where the
/// code for it is, and the diagram as it now stands.
pub fn describe(
    file: &DiagramFile,
    edits: &[Edit],
    path: &Path,
    root: &Path,
    note: &str,
) -> Result<String> {
    let mut after = file.diagram.clone();
    apply(&mut after, edits)?;
    let label = |id: &str| -> String {
        after
            .nodes
            .get(id)
            .or_else(|| file.diagram.nodes.get(id))
            .map(|n| n.label.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let named = |id: &str| -> String {
        let mut out = format!("`{id}` \"{}\"", label(id));
        if let Some(code) = file.code.get(id) {
            out.push_str(&format!(" — code: {}", code.describe()));
        }
        out
    };

    let mut lines = vec![format!(
        "The architecture diagram at {} changed. Make the code under {} match it.",
        path.display(),
        root.display()
    )];
    if !note.trim().is_empty() {
        lines.push(String::new());
        lines.push(note.trim().to_string());
    }
    lines.push(String::new());
    for edit in edits {
        lines.push(match edit {
            Edit::AddNode { id, .. } => format!("- New component {}. Build it.", named(id)),
            Edit::AddEdge { from, to, label: l } => {
                let how = if l.trim().is_empty() { String::new() } else { format!(" ({})", l.trim()) };
                format!("- {} now depends on {}{how}.", named(from), named(to))
            }
            Edit::Rename { id, label: new } => {
                let old = file.diagram.nodes.get(id).map(|n| n.label.as_str()).unwrap_or(id);
                format!("- {} is renamed from \"{old}\" to \"{}\". Rename it in the code.", named(id), clean_label(new))
            }
            Edit::RemoveNode { id } => format!("- Remove the component {}.", named(id)),
            Edit::RemoveEdge { from, to } => {
                format!("- {} no longer depends on {}. Cut that dependency.", named(from), named(to))
            }
        });
    }
    lines.push(String::new());
    lines.push(
        "The diagram says where each component lives with `%% OXDRAW CODE <node> <path>` \
         lines. When you add code for a new component, add its line to the diagram too."
            .into(),
    );
    lines.push(String::new());
    lines.push("The diagram now:".into());
    lines.push("```mermaid".into());
    lines.push(after.to_definition().trim_end().to_string());
    lines.push("```".into());
    Ok(lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "graph TD
    web[Web UI]
    hub[Hub]
    store[Store]
    web --> hub
    hub --> store

%% OXDRAW CODE hub crates/oxroute-core/src/hub.rs line:1-40 def:Hub
%% OXDRAW CODE store crates/oxroute-core/src/store.rs
%% OXDRAW CODE broken
";

    fn add_cache() -> Vec<Edit> {
        vec![
            Edit::AddNode { id: "cache".into(), label: "Board cache".into() },
            Edit::AddEdge { from: "hub".into(), to: "cache".into(), label: "reads".into() },
        ]
    }

    #[test]
    fn the_code_map_reads_and_a_half_typed_line_is_skipped() {
        let refs = code_refs(FILE);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs["hub"].lines.as_deref(), Some("1-40"));
        assert_eq!(refs["hub"].symbol.as_deref(), Some("Hub"));
        assert_eq!(refs["store"].file, "crates/oxroute-core/src/store.rs");
    }

    #[test]
    fn edits_apply_in_order_and_a_bad_one_is_refused_whole() {
        let file = DiagramFile::parse(FILE).unwrap();
        let mut diagram = file.diagram.clone();
        apply(&mut diagram, &add_cache()).unwrap();
        assert_eq!(diagram.nodes["cache"].label, "Board cache");
        assert!(diagram.edges.iter().any(|e| e.from == "hub" && e.to == "cache"));

        let mut diagram = file.diagram.clone();
        let error = apply(
            &mut diagram,
            &[Edit::AddEdge { from: "hub".into(), to: "nowhere".into(), label: String::new() }],
        )
        .unwrap_err();
        assert!(error.to_string().contains("no box called nowhere"));
        let error = apply(&mut diagram, &[Edit::AddNode { id: "hub".into(), label: "x".into() }]).unwrap_err();
        assert!(error.to_string().contains("already a box"));
        let error = apply(&mut diagram, &[Edit::AddNode { id: "2x".into(), label: "x".into() }]).unwrap_err();
        assert!(error.to_string().contains("cannot name a box"));
    }

    #[test]
    fn the_preview_marks_what_is_new_and_places_every_box() {
        let file = DiagramFile::parse(FILE).unwrap();
        let drawn = draw(&file, &add_cache()).unwrap();
        let cache = drawn.nodes.iter().find(|n| n.id == "cache").unwrap();
        assert_eq!(cache.change.as_deref(), Some("added"));
        assert!(cache.x >= 0.0 && cache.x + cache.width <= drawn.width + 0.5);
        assert!(drawn.svg.contains(ADDED.0), "the new box is not coloured in");
        let hub = drawn.nodes.iter().find(|n| n.id == "hub").unwrap();
        assert_eq!(hub.code.as_ref().unwrap().file, "crates/oxroute-core/src/hub.rs");
        assert!(drawn.edges.iter().any(|e| e.from == "hub" && e.to == "cache" && e.added));
        assert!(drawn.edges.iter().any(|e| e.from == "web" && !e.added));

        let drawn = draw(&file, &[Edit::RemoveNode { id: "store".into() }]).unwrap();
        assert_eq!(drawn.removed, ["store"]);
    }

    #[test]
    fn a_rewrite_keeps_the_code_map_for_boxes_that_are_still_there() {
        let file = DiagramFile::parse(FILE).unwrap();
        let mut edits = add_cache();
        edits.push(Edit::RemoveNode { id: "store".into() });
        let out = rewrite(&file, &edits).unwrap();
        assert!(out.contains("cache[Board cache]"), "{out}");
        assert!(out.contains("%% OXDRAW CODE hub crates/oxroute-core/src/hub.rs line:1-40 def:Hub"));
        assert!(!out.contains("store.rs"), "a removed box kept its code line:\n{out}");
        // What it wrote reads back as the diagram it meant.
        let again = DiagramFile::parse(&out).unwrap();
        assert!(again.diagram.nodes.contains_key("cache"));
        assert!(!again.diagram.nodes.contains_key("store"));
    }

    #[test]
    fn the_request_says_what_changed_and_where_the_code_is() {
        let file = DiagramFile::parse(FILE).unwrap();
        let mut edits = add_cache();
        edits.push(Edit::Rename { id: "hub".into(), label: "Router".into() });
        let text = describe(&file, &edits, Path::new("/r/docs/arch.mmd"), Path::new("/r"), "keep it small").unwrap();
        assert!(text.starts_with("The architecture diagram at /r/docs/arch.mmd changed."));
        assert!(text.contains("keep it small"));
        assert!(text.contains("New component `cache` \"Board cache\". Build it."));
        assert!(text.contains("code: crates/oxroute-core/src/hub.rs lines 1-40 (Hub)"));
        assert!(text.contains("renamed from \"Hub\" to \"Router\""));
        assert!(text.contains("```mermaid"));
        assert_eq!(
            touched(&edits).into_iter().collect::<Vec<_>>(),
            ["cache", "hub"]
        );
        assert_eq!(title(&file, &edits), "Add Board cache, and 2 more");
        let wire = [Edit::AddEdge { from: "web".into(), to: "store".into(), label: String::new() }];
        assert_eq!(title(&file, &wire), "Wire Web UI to Store");
    }

    /// `app/lib/types.ts` reads these by name; see the same test in
    /// `oxroute-core`'s model and board.
    #[test]
    fn the_wire_names_the_diagram_view_reads_do_not_move() {
        let file = DiagramFile::parse(FILE).unwrap();
        let drawn = serde_json::to_value(draw(&file, &add_cache()).unwrap()).unwrap();
        for key in ["svg", "width", "height", "nodes", "edges", "removed"] {
            assert!(drawn.get(key).is_some(), "Drawn lost {key}");
        }
        let hub = drawn["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "hub").unwrap();
        for key in ["label", "x", "y", "width", "height", "code", "change"] {
            assert!(hub.get(key).is_some(), "a box lost {key}");
        }
        assert_eq!(hub["code"]["file"], "crates/oxroute-core/src/hub.rs");
        assert!(drawn["edges"][0].get("added").is_some());
    }

    #[test]
    fn edits_arrive_as_the_web_ui_sends_them() {
        let edits: Vec<Edit> = serde_json::from_str(
            r#"[{"op": "addNode", "id": "cache", "label": "Cache"},
                {"op": "addEdge", "from": "hub", "to": "cache"},
                {"op": "removeEdge", "from": "web", "to": "hub"}]"#,
        )
        .unwrap();
        assert_eq!(edits.len(), 3);
        assert_eq!(edits[1], Edit::AddEdge { from: "hub".into(), to: "cache".into(), label: String::new() });
    }
}

#[cfg(test)]
mod repository {
    use super::*;

    /// The diagram this repository ships describes this repository. If a
    /// file it points at moves, the diagram is wrong, and so is this test.
    #[test]
    fn the_architecture_diagram_reads_and_every_box_points_at_real_code() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let file = DiagramFile::read(&root.join("docs/architecture.mmd")).unwrap();
        let drawn = draw(&file, &[]).unwrap();
        assert!(drawn.nodes.len() >= 10);
        for node in &drawn.nodes {
            let code = node.code.as_ref().unwrap_or_else(|| panic!("{} has no code", node.id));
            assert!(root.join(&code.file).exists(), "{} points at {}", node.id, code.file);
        }
    }
}
