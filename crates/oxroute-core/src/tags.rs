//! Tags on sessions, and boards made of them.
//!
//! A tag is `key:value` (`stage:idea`, `priority:p2`) or a bare word
//! (`urgent`). A person tags a session from any surface; an agent tags its
//! own session over the API. Nothing here knows what any tag means.
//!
//! A board is a saved way of looking at the tagged sessions: which key makes
//! the columns and which the rows, what order they go in, which keys are
//! offered as filters and which values are selected, and what sorts the
//! cards. With both set the board is a grid -- projects down the side,
//! stages across the top -- and each card sits in the cell its two tags
//! name. Moving a card to another cell is setting those tags. So a board of ideas by stage and
//! a board of work by owner are the same code with different settings, and
//! anyone -- a person or an agent -- can make another.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::model::Agent;

/// The longest tag worth keeping. Past this it is a sentence, not a tag.
pub const MAX_TAG: usize = 64;

/// `Stage: In Progress ` -> `stage:in-progress`. `None` for something that
/// cannot be a tag: empty, too long, or a key or value missing either side
/// of the colon.
pub fn normalize(raw: &str) -> Option<String> {
    let folded = raw
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    let tag: String = folded
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ':' | '-' | '_' | '.' | '/'))
        .collect();
    if tag.is_empty() || tag.chars().count() > MAX_TAG {
        return None;
    }
    let tag = match tag.split_once(':') {
        Some((key, value)) => {
            let (key, value) = (key.trim_matches('-'), value.trim_matches('-'));
            if key.is_empty() || value.is_empty() {
                return None;
            }
            format!("{key}:{value}")
        }
        None => tag,
    };
    Some(tag)
}

/// `stage` for `stage:idea`, `None` for a bare word.
pub fn key(tag: &str) -> Option<&str> {
    tag.split_once(':').map(|(key, _)| key)
}

/// `idea` for `stage:idea`, the whole tag for a bare word.
pub fn value(tag: &str) -> &str {
    tag.split_once(':').map_or(tag, |(_, value)| value)
}

/// A session's tags after a change. `set` replaces every tag with the same
/// key, which is what a column move and "the stage is now X" both mean;
/// `add` keeps them, so a session can be `track:oss` and `track:business`.
pub fn change(current: &[String], add: &[String], remove: &[String], set: &[String]) -> Vec<String> {
    let set: Vec<String> = set.iter().filter_map(|t| normalize(t)).collect();
    let replaced: BTreeSet<&str> = set.iter().filter_map(|t| key(t)).collect();
    let remove: BTreeSet<String> = remove.iter().filter_map(|t| normalize(t)).collect();
    let mut out: BTreeSet<String> = current
        .iter()
        .filter(|t| !remove.contains(*t))
        // A bare key in `remove` takes every value of it off.
        .filter(|t| key(t).is_none_or(|k| !remove.contains(k)))
        .filter(|t| key(t).is_none_or(|k| !replaced.contains(k)))
        .cloned()
        .collect();
    out.extend(add.iter().filter_map(|t| normalize(t)));
    out.extend(set);
    out.into_iter().collect()
}

// -- boards ------------------------------------------------------------------

/// A saved arrangement of sessions by their tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub name: String,
    /// The tag key whose values are the columns. Empty: one column.
    #[serde(default)]
    pub columns: String,
    /// Column values in the order to show them. Values not listed follow,
    /// and a value listed that no session has yet is an empty column to
    /// drag into.
    #[serde(default)]
    pub column_order: Vec<String>,
    /// The tag key whose values are the rows. Empty: one row.
    #[serde(default)]
    pub rows: String,
    /// Row values in the order to show them, as for columns.
    #[serde(default)]
    pub row_order: Vec<String>,
    /// Keys offered as filters, each as a row of its values.
    #[serde(default)]
    pub filters: Vec<String>,
    /// Tags a card must have. Within one key any of them will do; across
    /// keys, all must hold -- `priority:p1 priority:p2 type:oss` means p1
    /// or p2, and oss.
    #[serde(default)]
    pub selected: Vec<String>,
    /// A key to sort cards by, lowest value first. Empty: most recent first.
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub created_at: f64,
    #[serde(default)]
    pub updated_at: f64,
}

impl Board {
    /// Normalise everything a person or an agent typed into it, so a board
    /// written through the API reads the same as one made in the interface.
    pub fn cleaned(mut self) -> Self {
        self.name = self.name.trim().to_string();
        let key_of = |raw: &str| normalize(raw).map(|k| k.split(':').next().unwrap_or("").to_string());
        self.columns = key_of(&self.columns).unwrap_or_default();
        self.rows = key_of(&self.rows).unwrap_or_default();
        self.sort = key_of(&self.sort).unwrap_or_default();
        self.filters = dedup(self.filters.iter().filter_map(|k| key_of(k)));
        // A value may be typed with its key; the orders keep values.
        let values = |order: &[String]| {
            dedup(order.iter().filter_map(|v| normalize(v)).map(|v| value(&v).to_string()))
        };
        self.column_order = values(&self.column_order);
        self.row_order = values(&self.row_order);
        self.selected = dedup(self.selected.iter().filter_map(|t| normalize(t)));
        self
    }
}

fn dedup(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    items.filter(|item| !item.is_empty() && seen.insert(item.clone())).collect()
}

/// One row of the grid. `value` is `None` for the sessions without the
/// row key; `cells` line up with [`Arranged::columns`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub value: Option<String>,
    pub cells: Vec<Vec<String>>,
}

/// A board worked out against the sessions as they are now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Arranged {
    pub board: Board,
    /// Column values, left to right. `None` is the column of sessions
    /// without the column key, and the only column when there is no key.
    pub columns: Vec<Option<String>>,
    pub rows: Vec<Row>,
    /// The sessions on the board, by id. A board reaches further back than
    /// the fleet does, so it carries its own.
    pub sessions: HashMap<String, Agent>,
    /// Every key in use, with every value it has, for the pickers.
    pub values: BTreeMap<String, Vec<String>>,
    /// Bare tags in use.
    pub plain: Vec<String>,
    /// Sessions that pass the filters, of how many.
    pub shown: usize,
    pub total: usize,
}

/// Does a session with these tags pass the board's filters?
pub fn passes(tags: &[String], selected: &[String]) -> bool {
    let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for tag in selected {
        groups.entry(key(tag).unwrap_or(tag)).or_default().push(tag);
    }
    groups
        .values()
        .all(|any| any.iter().any(|wanted| tags.iter().any(|t| t == wanted)))
}

/// `p2` before `p10`: digits compare as numbers, the rest as text.
fn natural(a: &str, b: &str) -> Ordering {
    let split = |s: &str| {
        let digits: String = s.chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
        (s.chars().take_while(|c| !c.is_ascii_digit()).collect::<String>(), digits.parse::<u64>().ok())
    };
    let ((pa, na), (pb, nb)) = (split(a), split(b));
    pa.cmp(&pb).then(match (na, nb) {
        (Some(x), Some(y)) => x.cmp(&y),
        _ => Ordering::Equal,
    })
    .then_with(|| a.cmp(b))
}

/// Lay a board out.
///
/// Columns come from every session, not just the filtered ones, so a filter
/// never makes a column vanish from under a card being dragged to it.
pub fn arrange(board: &Board, agents: &[Agent], tags: &HashMap<String, Vec<String>>) -> Arranged {
    let empty = Vec::new();
    let tags_of = |agent: &Agent| tags.get(&agent.id).unwrap_or(&empty);

    let mut values: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut plain = BTreeSet::new();
    for agent in agents {
        for tag in tags_of(agent) {
            match key(tag) {
                Some(k) => {
                    values.entry(k.to_string()).or_default().insert(value(tag).to_string());
                }
                None => {
                    plain.insert(tag.clone());
                }
            }
        }
    }

    let mut shown: Vec<&Agent> = agents.iter().filter(|a| passes(tags_of(a), &board.selected)).collect();
    let sort_value = |agent: &Agent| -> Option<String> {
        if board.sort.is_empty() {
            return None;
        }
        tags_of(agent)
            .iter()
            .find(|t| key(t) == Some(board.sort.as_str()))
            .map(|t| value(t).to_string())
    };
    shown.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| match (sort_value(a), sort_value(b)) {
                (Some(x), Some(y)) => natural(&x, &y),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            })
            .then_with(|| b.updated_at.total_cmp(&a.updated_at))
    });

    let value_of = |agent: &Agent, key: &str| -> Option<String> {
        tags_of(agent)
            .iter()
            .find(|t| self::key(t) == Some(key))
            .map(|t| value(t).to_string())
    };
    // The lanes for one key: the chosen order, then every other value in
    // use, then -- when a card has none -- the lane of cards without it.
    let lanes = |key: &str, order: &[String]| -> Vec<Option<String>> {
        if key.is_empty() {
            return vec![None];
        }
        let mut out: Vec<String> = order.to_vec();
        let mut rest: Vec<String> = values
            .get(key)
            .into_iter()
            .flatten()
            .filter(|v| !out.contains(v))
            .cloned()
            .collect();
        rest.sort_by(|a, b| natural(a, b));
        out.extend(rest);
        let mut lanes: Vec<Option<String>> = out.into_iter().map(Some).collect();
        if shown.iter().any(|a| value_of(a, key).is_none()) {
            lanes.push(None);
        }
        lanes
    };
    let columns = lanes(&board.columns, &board.column_order);
    let rows = lanes(&board.rows, &board.row_order)
        .into_iter()
        .map(|row| Row {
            cells: columns
                .iter()
                .map(|column| {
                    shown
                        .iter()
                        .filter(|a| board.rows.is_empty() || value_of(a, &board.rows) == row)
                        .filter(|a| board.columns.is_empty() || value_of(a, &board.columns) == *column)
                        .map(|a| a.id.clone())
                        .collect()
                })
                .collect(),
            value: row,
        })
        .collect();

    Arranged {
        board: board.clone(),
        sessions: shown.iter().map(|a| (a.id.clone(), (*a).clone())).collect(),
        columns,
        rows,
        values: values.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect(),
        plain: plain.into_iter().collect(),
        shown: shown.len(),
        total: agents.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, Backend};

    fn agent(id: &str, at: f64) -> Agent {
        Agent {
            id: id.into(),
            name: id.into(),
            backend: Backend::ClaudeCode,
            model: "m".into(),
            session_id: String::new(),
            cwd: String::new(),
            status: AgentStatus::Working,
            activity: String::new(),
            permalink: String::new(),
            last_activity: at,
            updated_at: at,
            stall_reason: None,
            stall_alerted: false,
            pinned: false,
        }
    }

    fn tagged(pairs: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(id, tags)| (id.to_string(), tags.iter().map(|t| t.to_string()).collect()))
            .collect()
    }

    fn board(columns: &str) -> Board {
        Board {
            id: "b".into(),
            name: "Ideas".into(),
            columns: columns.into(),
            column_order: vec![],
            rows: String::new(),
            row_order: vec![],
            filters: vec![],
            selected: vec![],
            sort: String::new(),
            created_at: 0.0,
            updated_at: 0.0,
        }
    }

    #[test]
    fn a_tag_is_whatever_was_typed_made_regular() {
        assert_eq!(normalize(" Stage: In Progress ").as_deref(), Some("stage:in-progress"));
        assert_eq!(normalize("URGENT").as_deref(), Some("urgent"));
        assert_eq!(normalize("type:business").as_deref(), Some("type:business"));
        for bad in ["", "   ", ":idea", "stage:", &"x".repeat(80)] {
            assert_eq!(normalize(bad), None, "{bad:?} made a tag");
        }
        assert_eq!(key("stage:idea"), Some("stage"));
        assert_eq!(value("stage:idea"), "idea");
        assert_eq!(value("urgent"), "urgent");
    }

    #[test]
    fn set_replaces_a_key_add_keeps_it_and_remove_takes_a_tag_or_a_whole_key() {
        let now = vec!["stage:idea".to_string(), "track:oss".to_string(), "urgent".to_string()];
        let s = |v: &[&str]| v.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert_eq!(
            change(&now, &s(&["track:business"]), &[], &s(&["Stage:Building"])),
            ["stage:building", "track:business", "track:oss", "urgent"]
        );
        assert_eq!(change(&now, &[], &s(&["urgent", "track"]), &[]), ["stage:idea"]);
    }

    #[test]
    fn filters_are_any_within_a_key_and_all_across_keys() {
        let tags = |t: &[&str]| t.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let selected = tags(&["priority:p1", "priority:p2", "type:oss"]);
        assert!(passes(&tags(&["priority:p2", "type:oss"]), &selected));
        assert!(!passes(&tags(&["priority:p3", "type:oss"]), &selected));
        assert!(!passes(&tags(&["priority:p1"]), &selected));
        assert!(passes(&tags(&["anything"]), &[]));
        assert!(passes(&tags(&["urgent", "x"]), &tags(&["urgent"])));
    }

    /// The cards in one cell, by row and column value.
    fn cell(laid: &Arranged, row: Option<&str>, column: Option<&str>) -> Vec<String> {
        let at = laid.columns.iter().position(|c| c.as_deref() == column).expect("no such column");
        laid.rows.iter().find(|r| r.value.as_deref() == row).expect("no such row").cells[at].clone()
    }

    #[test]
    fn columns_follow_the_order_then_the_rest_and_the_untagged_go_last() {
        let agents = [agent("a", 1.0), agent("b", 2.0), agent("c", 3.0), agent("d", 4.0)];
        let tags = tagged(&[
            ("a", &["stage:idea"]),
            ("b", &["stage:building"]),
            ("c", &["stage:eval"]),
            ("d", &["urgent"]),
        ]);
        let mut b = board("stage");
        b.column_order = vec!["idea".into(), "building".into(), "shipped".into()];
        let laid = arrange(&b, &agents, &tags);
        let names: Vec<Option<&str>> = laid.columns.iter().map(|c| c.as_deref()).collect();
        assert_eq!(names, [Some("idea"), Some("building"), Some("shipped"), Some("eval"), None]);
        // No row key: one row.
        assert_eq!(laid.rows.len(), 1);
        // A column nobody is in yet is still there to drag into.
        assert!(cell(&laid, None, Some("shipped")).is_empty());
        assert_eq!(cell(&laid, None, None), ["d"]);
        assert_eq!(laid.values["stage"], ["building", "eval", "idea"]);
        assert_eq!(laid.plain, ["urgent"]);
    }

    #[test]
    fn rows_and_columns_make_a_grid_and_each_card_sits_where_its_two_tags_say() {
        let agents = [agent("a", 1.0), agent("b", 2.0), agent("c", 3.0), agent("d", 4.0)];
        let tags = tagged(&[
            ("a", &["project:agents", "stage:idea"]),
            ("b", &["project:agents", "stage:building"]),
            ("c", &["project:compilers", "stage:idea"]),
            ("d", &["stage:building"]),
        ]);
        let mut b = board("stage");
        b.column_order = vec!["idea".into(), "building".into()];
        b.rows = "project".into();
        let laid = arrange(&b, &agents, &tags);
        let rows: Vec<Option<&str>> = laid.rows.iter().map(|r| r.value.as_deref()).collect();
        assert_eq!(rows, [Some("agents"), Some("compilers"), None]);
        assert_eq!(cell(&laid, Some("agents"), Some("idea")), ["a"]);
        assert_eq!(cell(&laid, Some("agents"), Some("building")), ["b"]);
        assert_eq!(cell(&laid, Some("compilers"), Some("idea")), ["c"]);
        assert!(cell(&laid, Some("compilers"), Some("building")).is_empty());
        // No project yet: the row for sessions without one.
        assert_eq!(cell(&laid, None, Some("building")), ["d"]);
        assert!(laid.rows.iter().all(|r| r.cells.len() == laid.columns.len()));
    }

    #[test]
    fn a_filter_hides_cards_but_never_a_column() {
        let agents = [agent("a", 1.0), agent("b", 2.0)];
        let tags = tagged(&[("a", &["stage:idea", "type:oss"]), ("b", &["stage:building"])]);
        let mut b = board("stage");
        b.selected = vec!["type:oss".into()];
        let laid = arrange(&b, &agents, &tags);
        assert_eq!((laid.shown, laid.total), (1, 2));
        assert!(cell(&laid, None, Some("building")).is_empty());
    }

    #[test]
    fn cards_sort_by_a_tag_naturally_then_by_recency_with_pins_first() {
        let mut pinned = agent("pinned", 0.0);
        pinned.pinned = true;
        let agents = [agent("p10", 5.0), agent("p2", 1.0), agent("none", 9.0), pinned, agent("p2new", 3.0)];
        let tags = tagged(&[
            ("p10", &["priority:p10"]),
            ("p2", &["priority:p2"]),
            ("p2new", &["priority:p2"]),
            ("pinned", &["priority:p3"]),
        ]);
        let mut b = board("");
        b.sort = "priority".into();
        let order = arrange(&b, &agents, &tags).rows[0].cells[0].clone();
        assert_eq!(order, ["pinned", "p2new", "p2", "p10", "none"]);
    }

    #[test]
    fn a_board_written_by_hand_reads_like_one_made_in_the_interface() {
        let b = Board {
            name: "  Ideas ".into(),
            columns: "Stage".into(),
            column_order: vec!["Idea".into(), "stage:Building".into(), "idea".into()],
            rows: "Project".into(),
            filters: vec!["Priority".into(), "priority".into()],
            selected: vec!["Priority: P1".into()],
            sort: "priority:p1".into(),
            ..board("")
        }
        .cleaned();
        assert_eq!(b.name, "Ideas");
        assert_eq!(b.columns, "stage");
        assert_eq!(b.column_order, ["idea", "building"]);
        assert_eq!(b.rows, "project");
        assert_eq!(b.filters, ["priority"]);
        assert_eq!(b.selected, ["priority:p1"]);
        assert_eq!(b.sort, "priority");
    }

    #[test]
    fn the_wire_names_the_board_reads_do_not_move() {
        let laid = arrange(&board("stage"), &[agent("a", 1.0)], &tagged(&[("a", &["stage:idea"])]));
        let encoded = serde_json::to_value(&laid).unwrap();
        for key in ["board", "columns", "rows", "sessions", "values", "plain", "shown", "total"] {
            assert!(encoded.get(key).is_some(), "Arranged lost {key}");
        }
        for key in [
            "columns", "columnOrder", "rows", "rowOrder", "filters", "selected", "sort", "createdAt",
            "updatedAt",
        ] {
            assert!(encoded["board"].get(key).is_some(), "Board lost {key}");
        }
        assert_eq!(encoded["columns"][0], "idea");
        assert_eq!(encoded["rows"][0]["value"], serde_json::Value::Null);
        assert_eq!(encoded["rows"][0]["cells"][0][0], "a");
    }
}
