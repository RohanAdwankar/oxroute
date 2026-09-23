//! What the agent is doing right now, rendered for a human to watch.
//!
//! During a turn the harness emits a lot: commands, their output, file
//! diffs, tool calls, sub-agents. Posting a message per item would bury the
//! thread, so all of it shares one message that is rewritten in place and
//! taken away when the turn ends.
//!
//! The rendering is pure and lives apart from the posting, because what to
//! keep when the text will not fit is the part worth testing.

use std::collections::BTreeMap;

use serde_json::Value;

/// Slack's own ceiling. Other surfaces are more generous but the same
//  budget keeps one renderer for all of them.
pub const MAX_BYTES: usize = 3_500;
const MIN_BYTES: usize = 512;

/// Item types whose name reads badly when mechanically un-camel-cased.
fn label_for(kind: &str) -> String {
    match kind {
        "fileChange" => "File changes".into(),
        "webSearch" => "Web search".into(),
        "imageView" => "View image".into(),
        "imageGeneration" => "Generate image".into(),
        "collabAgentToolCall" => "Agent tool".into(),
        "subAgentActivity" => "Sub-agent".into(),
        "contextCompaction" => "Context compaction".into(),
        "commandExecution" => "Command".into(),
        "" => "Activity".into(),
        other => {
            let spaced = other.replace('_', " ");
            let mut chars = spaced.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Activity".into(),
            }
        }
    }
}

/// One line describing a harness item: what it did, and to what.
///
/// Returns `None` for anything not worth a timeline row -- a half-finished
/// item, a streamed chunk, the model's own prose.
pub struct Summary {
    pub label: String,
    pub detail: String,
    pub output: String,
    pub item_id: String,
}

pub fn summarize(item: &Value) -> Option<Summary> {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if matches!(kind, "agentMessage" | "userMessage" | "reasoning" | "toolResult" | "") {
        return None;
    }
    // Items arrive twice, started then completed. Recording both would
    // double every row, and the started one has nothing in it yet.
    if item.get("_delta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if item.get("status").and_then(Value::as_str) == Some("inProgress") {
        return None;
    }

    let detail = match kind {
        "commandExecution" => item
            .pointer("/commandActions/0/command")
            .and_then(Value::as_str)
            .or_else(|| item.get("command").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        "fileChange" => item
            .get("changes")
            .and_then(Value::as_array)
            .map(|changes| {
                changes
                    .iter()
                    .filter_map(|c| c.get("path").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
        "mcpToolCall" | "toolCall" | "dynamicToolCall" => item
            .pointer("/arguments/command")
            .and_then(Value::as_str)
            .or_else(|| item.pointer("/arguments/file_path").and_then(Value::as_str))
            .or_else(|| item.pointer("/arguments/path").and_then(Value::as_str))
            .or_else(|| item.pointer("/arguments/pattern").and_then(Value::as_str))
            .or_else(|| item.pointer("/arguments/description").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        _ => item
            .get("query")
            .or_else(|| item.get("path"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };

    let label = match kind {
        "mcpToolCall" | "toolCall" | "dynamicToolCall" => item
            .get("tool")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| label_for(kind)),
        _ => label_for(kind),
    };
    Some(Summary {
        label,
        detail: one_line(&detail, 200),
        output: item_output(item),
        item_id: item.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

pub fn item_output(item: &Value) -> String {
    for field in ["aggregatedOutput", "streamedOutput", "result", "error"] {
        if let Some(value) = item.get(field).filter(|value| !value.is_null()) {
            return value.as_str().map(str::to_string).unwrap_or_else(|| pretty(value));
        }
    }
    String::new()
}

/// Everything seen so far in one turn.
pub struct Progress {
    /// Insertion-ordered by a counter, because a later item must render
    /// below an earlier one even when their ids sort the other way.
    entries: BTreeMap<u64, (String, Value)>,
    index: std::collections::HashMap<String, u64>,
    next: u64,
    /// Commentary the model emits mid-turn, which reads as an update rather
    /// than as tool noise.
    pub commentary: Vec<String>,
    pub started: std::time::Instant,
    dirty: bool,
}

impl Default for Progress {
    fn default() -> Self {
        Progress::new()
    }
}

impl Progress {
    pub fn new() -> Self {
        Progress {
            entries: BTreeMap::new(),
            index: std::collections::HashMap::new(),
            next: 0,
            commentary: Vec::new(),
            started: std::time::Instant::now(),
            dirty: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.commentary.is_empty()
    }

    /// True when something has changed since the last `render`.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.commentary.push(text.into());
        self.dirty = true;
    }

    /// Fold one harness item in. Items arrive twice -- started, then
    /// completed -- and the second replaces the first.
    pub fn observe(&mut self, item: &Value) {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        // The final answer is posted as the reply; repeating it here would
        // show it twice and then delete one copy.
        if kind == "agentMessage" {
            let phase = item.get("phase").and_then(Value::as_str);
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            if phase != Some("final_answer") && !text.is_empty() {
                self.note(text);
            }
            return;
        }
        if matches!(kind, "userMessage" | "reasoning") {
            return;
        }

        let key = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{kind}:{}", self.next));

        let slot = *self.index.entry(key.clone()).or_insert_with(|| {
            let slot = self.next;
            self.next += 1;
            slot
        });

        // A streamed chunk appends to whatever output is already there
        // instead of replacing the item wholesale.
        if item.get("_delta").and_then(Value::as_bool) == Some(true) {
            let delta = item
                .get("streamedOutput")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let entry = self
                .entries
                .entry(slot)
                .or_insert_with(|| (kind.to_string(), serde_json::json!({ "type": kind })));
            let existing = entry
                .1
                .get("streamedOutput")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            entry.1["streamedOutput"] = Value::String(existing + &delta);
        } else {
            self.entries.insert(slot, (kind.to_string(), item.clone()));
        }
        self.dirty = true;
    }

    /// One line for the agent list: the most recent thing it did.
    ///
    /// What it just *saw* beats what it just ran -- "e2e.txt  notes.md" is
    /// worth a line, "toolcall Bash" is not -- so output wins, then the
    /// command, then the model's own prose, then the bare item name.
    pub fn activity(&self) -> String {
        if let Some((kind, item)) = self.entries.values().next_back() {
            let output = item
                .get("aggregatedOutput")
                .or_else(|| item.get("streamedOutput"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if !output.is_empty() {
                return one_line(output, 160);
            }

            let detail = item
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| item.pointer("/commandActions/0/command").and_then(Value::as_str))
                .or_else(|| item.pointer("/arguments/command").and_then(Value::as_str))
                .or_else(|| item.pointer("/arguments/file_path").and_then(Value::as_str))
                .or_else(|| item.pointer("/arguments/path").and_then(Value::as_str))
                .or_else(|| item.pointer("/arguments/pattern").and_then(Value::as_str))
                .or_else(|| item.get("path").and_then(Value::as_str))
                .unwrap_or_default()
                .trim();
            if !detail.is_empty() {
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or_default();
                return one_line(
                    &if tool.is_empty() {
                        detail.to_string()
                    } else {
                        format!("{tool}  {detail}")
                    },
                    160,
                );
            }

            if let Some(latest) = self.commentary.last() {
                return one_line(latest, 160);
            }
            return label_for(kind).to_lowercase();
        }
        if let Some(latest) = self.commentary.last() {
            return one_line(latest, 160);
        }
        "starting".into()
    }

    /// The whole thing, trimmed to fit.
    ///
    /// The header always survives. Past that, the most recent activity is
    /// what a watcher wants, so the middle is dropped from the oldest end.
    pub fn render(&self, limit: usize) -> String {
        let mut chunks = vec![self.header()];
        for text in &self.commentary {
            chunks.push(format!("*Update*\n{text}"));
        }
        for (kind, item) in self.entries.values() {
            chunks.push(format_entry(kind, item));
        }

        let whole = chunks.join("\n\n");
        if byte_len(&whole) <= limit {
            return whole;
        }

        let mut kept: Vec<String> = vec![chunks[0].clone()];
        for chunk in chunks[1..].iter().rev() {
            let mut candidate = vec![kept[0].clone(), chunk.clone()];
            candidate.extend_from_slice(&kept[1..]);
            if byte_len(&candidate.join("\n\n")) > limit {
                if kept.len() == 1 {
                    // Not even one item fits beside the header. Show a
                    // squeezed version of the newest rather than nothing.
                    let room = limit.saturating_sub(byte_len(&kept[0])).saturating_sub(4);
                    kept.push(squeeze(chunk, room));
                }
                break;
            }
            kept.insert(1, chunk.clone());
        }
        kept.join("\n\n")
    }

    fn header(&self) -> String {
        let elapsed = self.started.elapsed().as_secs();
        let duration = if elapsed < 60 {
            format!("{elapsed}s")
        } else {
            format!("{}m {}s", elapsed / 60, elapsed % 60)
        };
        format!("*Working* · {duration}")
    }
}

fn format_entry(kind: &str, item: &Value) -> String {
    match kind {
        "commandExecution" => format_command(item),
        "fileChange" => format_file_change(item),
        "mcpToolCall" => format_tool(
            item,
            "MCP tool",
            &format!(
                "{}.{}",
                item.get("server").and_then(Value::as_str).unwrap_or(""),
                item.get("tool").and_then(Value::as_str).unwrap_or("")
            ),
        ),
        "toolCall" | "dynamicToolCall" => {
            let name = [
                item.get("namespace").and_then(Value::as_str),
                item.get("tool").and_then(Value::as_str),
            ]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(".");
            format_tool(item, "Tool", &name)
        }
        _ => {
            let mut out = heading(&label_for(kind), item, false);
            let details: serde_json::Map<_, _> = item
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(k, _)| !matches!(k.as_str(), "id" | "type" | "status" | "_delta"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if !details.is_empty() {
                out.push('\n');
                out.push_str(&code(&pretty(&Value::Object(details))));
            }
            out
        }
    }
}

fn format_command(item: &Value) -> String {
    let commands: Vec<&str> = item
        .get("commandActions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| a.get("command").and_then(Value::as_str))
        .collect();
    let command = if commands.is_empty() {
        item.get("command").and_then(Value::as_str).unwrap_or("").to_string()
    } else {
        commands.join("\n")
    };
    let output = item
        .get("aggregatedOutput")
        .or_else(|| item.get("streamedOutput"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let mut out = heading("Command", item, true);
    if let Some(cwd) = item.get("cwd").and_then(Value::as_str) {
        out.push_str(&format!("\n*Directory*  `{cwd}`"));
    }
    if !command.is_empty() {
        out.push('\n');
        out.push_str(&code(&command));
    }
    if !output.is_empty() {
        out.push_str("\n*Output*\n");
        out.push_str(&code(output.trim_end()));
    }
    if let Some(exit) = item.get("exitCode") {
        out.push_str(&format!("\n*Exit code*  `{exit}`"));
    }
    out
}

fn format_file_change(item: &Value) -> String {
    let mut out = heading("File changes", item, false);
    for change in item
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = change.get("kind");
        let kind_type = kind
            .and_then(|k| k.get("type").and_then(Value::as_str))
            .or_else(|| kind.and_then(Value::as_str))
            .unwrap_or("change");
        let label = match kind_type {
            "add" | "create" => "Added",
            "delete" => "Deleted",
            "move" => "Moved",
            "update" => "Updated",
            other => other,
        };
        let path = change.get("path").and_then(Value::as_str).unwrap_or("unknown path");
        let moved = kind
            .and_then(|k| k.get("move_path").and_then(Value::as_str))
            .map(|p| format!(" → `{p}`"))
            .unwrap_or_default();
        out.push_str(&format!("\n*{label}* `{path}`{moved}"));
        if let Some(diff) = change.get("diff").and_then(Value::as_str) {
            out.push('\n');
            out.push_str(&code(diff.trim_end()));
        }
    }
    out
}

fn format_tool(item: &Value, label: &str, name: &str) -> String {
    let mut out = heading(label, item, true);
    out.push_str(&format!("\n`{name}`"));
    for (field, title) in [("arguments", "Arguments"), ("result", "Result"), ("error", "Error")] {
        if let Some(value) = item.get(field).filter(|v| !v.is_null()) {
            out.push_str(&format!("\n*{title}*\n"));
            out.push_str(&code(&pretty(value)));
        }
    }
    out
}

fn heading(label: &str, item: &Value, with_duration: bool) -> String {
    let mut bits = Vec::new();
    if let Some(status) = item.get("status").and_then(Value::as_str) {
        bits.push(if status == "inProgress" {
            "in progress".to_string()
        } else {
            status.to_string()
        });
    }
    if with_duration {
        if let Some(ms) = item.get("durationMs").and_then(Value::as_f64) {
            bits.push(if ms < 1000.0 {
                format!("{ms:.0} ms")
            } else {
                format!("{:.1}s", ms / 1000.0)
            });
        }
    }
    if bits.is_empty() {
        format!("*{label}*")
    } else {
        format!("*{label}* · {}", bits.join(" · "))
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// Fence a block, defusing any fence inside it with a zero-width space so the
/// surrounding code block does not end early.
fn code(value: &str) -> String {
    format!("```{}```", value.replace("```", "``\u{200b}`"))
}

fn byte_len(value: &str) -> usize {
    value.len()
}

/// Keep the head and the tail of something too long, and say so in between.
fn squeeze(value: &str, limit: usize) -> String {
    if byte_len(value) <= limit || limit < MIN_BYTES / 8 {
        return truncate_chars(value, limit);
    }
    let marker = "\n… output truncated …\n";
    let room = limit.saturating_sub(marker.len());
    let head = room / 3;
    let tail = room - head;
    format!(
        "{}{marker}{}",
        truncate_chars(value, head),
        tail_chars(value, tail)
    )
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut end = limit.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn tail_chars(value: &str, limit: usize) -> String {
    let mut start = value.len().saturating_sub(limit);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

fn one_line(value: &str, limit: usize) -> String {
    let flat = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    let cut: String = flat.chars().take(limit.saturating_sub(1)).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_completed_item_replaces_the_started_one() {
        let mut progress = Progress::new();
        progress.observe(&json!({
            "id": "i1", "type": "commandExecution", "status": "inProgress",
            "command": "ls",
        }));
        progress.observe(&json!({
            "id": "i1", "type": "commandExecution", "status": "completed",
            "command": "ls", "exitCode": 0,
        }));
        let rendered = progress.render(MAX_BYTES);
        assert_eq!(rendered.matches("*Command*").count(), 1);
        assert!(rendered.contains("completed"));
    }

    #[test]
    fn streamed_output_accumulates_rather_than_replacing() {
        let mut progress = Progress::new();
        for chunk in ["one ", "two ", "three"] {
            progress.observe(&json!({
                "id": "i1", "type": "commandExecution",
                "streamedOutput": chunk, "_delta": true,
            }));
        }
        assert!(progress.render(MAX_BYTES).contains("one two three"));
    }

    #[test]
    fn the_final_answer_is_not_repeated_in_the_progress() {
        let mut progress = Progress::new();
        progress.observe(&json!({
            "id": "i1", "type": "agentMessage", "phase": "final_answer",
            "text": "all done",
        }));
        assert!(progress.is_empty());
        progress.observe(&json!({ "id": "i2", "type": "agentMessage", "text": "looking now" }));
        assert!(progress.render(MAX_BYTES).contains("looking now"));
    }

    #[test]
    fn trimming_keeps_the_header_and_the_newest_work() {
        let mut progress = Progress::new();
        for i in 0..40 {
            progress.observe(&json!({
                "id": format!("i{i}"), "type": "commandExecution",
                "command": format!("command-number-{i}"),
                "aggregatedOutput": "x".repeat(400),
            }));
        }
        let rendered = progress.render(MAX_BYTES);
        assert!(rendered.len() <= MAX_BYTES);
        assert!(rendered.starts_with("*Working*"));
        assert!(rendered.contains("command-number-39"));
        assert!(!rendered.contains("command-number-0\n"));
    }

    #[test]
    fn a_single_enormous_item_is_squeezed_not_dropped() {
        let mut progress = Progress::new();
        progress.observe(&json!({
            "id": "i1", "type": "commandExecution", "command": "big",
            "aggregatedOutput": "y".repeat(40_000),
        }));
        let rendered = progress.render(MAX_BYTES);
        assert!(rendered.len() <= MAX_BYTES);
        assert!(rendered.contains("truncated"));
    }

    #[test]
    fn a_fence_inside_output_cannot_close_the_block() {
        let mut progress = Progress::new();
        progress.observe(&json!({
            "id": "i1", "type": "commandExecution", "command": "cat readme",
            "aggregatedOutput": "```rust\nfn main() {}\n```",
        }));
        let rendered = progress.render(MAX_BYTES);
        assert_eq!(rendered.matches("```").count(), 4);
    }

    #[test]
    fn activity_is_one_short_line() {
        let mut progress = Progress::new();
        progress.observe(&json!({
            "id": "i1", "type": "commandExecution",
            "command": "kubectl get pods\n--all-namespaces",
        }));
        let activity = progress.activity();
        assert!(!activity.contains('\n'));
        assert!(activity.starts_with("kubectl get pods"));
    }

    #[test]
    fn output_beats_naming_the_tool() {
        let mut progress = Progress::new();
        progress.observe(&json!({
            "id": "i1", "type": "toolCall", "status": "completed",
            "tool": "Bash", "arguments": { "command": "ls" },
        }));
        assert_eq!(progress.activity(), "Bash ls");

        progress.observe(&json!({
            "id": "i2", "type": "toolResult", "status": "completed",
            "aggregatedOutput": "e2e.txt\nnotes.md",
        }));
        // What it saw, not what it ran.
        assert_eq!(progress.activity(), "e2e.txt notes.md");
    }

    #[test]
    fn a_tool_result_is_not_a_timeline_row_of_its_own() {
        // It is context for the command above it, and a row per result
        // would double the length of every timeline.
        assert!(summarize(&json!({
            "type": "toolResult", "status": "completed", "aggregatedOutput": "ok",
        }))
        .is_none());
    }

    #[test]
    fn completed_tool_output_is_kept_for_the_timeline() {
        let summary = summarize(&json!({
            "id": "anything", "type": "commandExecution", "status": "completed",
            "command": "printf hello", "aggregatedOutput": "hello\nworld\n",
        }))
        .unwrap();
        assert_eq!(summary.detail, "printf hello");
        assert_eq!(summary.output, "hello\nworld\n");
        assert_eq!(summary.item_id, "anything");
    }
}
