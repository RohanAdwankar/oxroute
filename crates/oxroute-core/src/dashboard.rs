//! One message that says what every agent is doing.
//!
//! It lives in whichever conversation last spoke to oxroute, it is edited
//! rather than reposted, and it is the thing you glance at instead of
//! scrolling. Stalls are announced in its thread, once each, so a wedged
//! agent is noticed without a stream of repeat pings.

use crate::model::{Agent, AgentStatus};

/// Everything unfinished, plus this many of the most recently finished. A
/// dashboard that grows without bound is a log.
pub const COMPLETED_SHOWN: usize = 10;

pub fn render(agents: &[Agent], now: f64) -> String {
    let mut counts = [0usize; 3];
    for agent in agents {
        counts[agent.status.rank() as usize] += 1;
    }
    let summary = [
        (counts[0], "working"),
        (counts[1], "stalled"),
        (counts[2], "complete"),
    ]
    .into_iter()
    .filter(|(n, _)| *n > 0)
    .map(|(n, label)| format!("{n} {label}"))
    .collect::<Vec<_>>()
    .join(" · ");
    let summary = if summary.is_empty() {
        "0 agents".to_string()
    } else {
        summary
    };

    let mut lines = vec!["*agents*".to_string(), summary, String::new()];
    for agent in agents {
        let reason = agent
            .stall_reason
            .as_deref()
            .filter(|r| !r.is_empty())
            .map(|r| format!(" · {r}"))
            .unwrap_or_default();
        let age = duration(now - agent.updated_at);
        let label = label(&agent.name);
        let link = if agent.permalink.is_empty() {
            label
        } else {
            format!("<{}|{label}>", agent.permalink)
        };
        lines.push(format!(
            "`{:<8} {:>3}`  {link}{reason}",
            agent.status.as_str(),
            age
        ));
    }
    lines.join("\n")
}

pub fn alert(user: &str, agent: &Agent, reason: &str) -> String {
    let label = label(&agent.name);
    let link = if agent.permalink.is_empty() {
        label
    } else {
        format!("<{}|{label}>", agent.permalink)
    };
    format!("<@{user}> {link} stalled: {reason}")
}

pub fn stalled_reason(timeout: f64) -> String {
    format!("no activity for {}", duration(timeout))
}

/// Escape the three characters Slack treats as markup, so a task named after
/// a shell pipeline does not render as a broken link.
fn label(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let clipped = if compact.chars().count() > 64 {
        let head: String = compact.chars().take(63).collect();
        format!("{}…", head.trim_end())
    } else {
        compact
    };
    clipped.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn duration(seconds: f64) -> String {
    let seconds = seconds.max(0.0) as u64;
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3_600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3_600),
        s => format!("{}d", s / 86_400),
    }
}

/// Order for any surface that lists agents: what is running, then what is
/// stuck, then what is done, newest first within each.
pub fn sort(agents: &mut [Agent]) {
    agents.sort_by(|a, b| {
        a.status
            .rank()
            .cmp(&b.status.rank())
            .then(b.updated_at.total_cmp(&a.updated_at))
    });
}

pub fn is_live(agent: &Agent) -> bool {
    agent.status != AgentStatus::Complete
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Backend;

    fn agent(name: &str, status: AgentStatus, updated: f64) -> Agent {
        Agent {
            id: name.into(),
            name: name.into(),
            backend: Backend::Codex,
            model: "sol".into(),
            session_id: String::new(),
            cwd: String::new(),
            status,
            activity: String::new(),
            permalink: String::new(),
            last_activity: updated,
            updated_at: updated,
            stall_reason: None,
            stall_alerted: false,
            pinned: false,
        }
    }

    #[test]
    fn empty_reads_as_empty_not_as_zeroes() {
        assert!(render(&[], 0.0).contains("0 agents"));
    }

    #[test]
    fn only_nonempty_categories_are_named() {
        let agents = vec![agent("a", AgentStatus::Working, 0.0)];
        let rendered = render(&agents, 0.0);
        assert!(rendered.contains("1 working"));
        assert!(!rendered.contains("stalled"));
    }

    #[test]
    fn markup_in_a_name_cannot_break_the_line() {
        let mut a = agent("fix <script> & co", AgentStatus::Working, 0.0);
        a.permalink = "https://example.com/x".into();
        let rendered = render(&[a], 0.0);
        assert!(rendered.contains("&lt;script&gt; &amp; co"));
    }

    #[test]
    fn sorting_puts_what_is_running_first() {
        let mut agents = vec![
            agent("done", AgentStatus::Complete, 100.0),
            agent("stuck", AgentStatus::Stalled, 50.0),
            agent("live", AgentStatus::Working, 10.0),
        ];
        sort(&mut agents);
        assert_eq!(
            agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["live", "stuck", "done"]
        );
    }

    #[test]
    fn durations_get_coarser_as_they_grow() {
        assert_eq!(duration(5.0), "5s");
        assert_eq!(duration(300.0), "5m");
        assert_eq!(duration(7_200.0), "2h");
        assert_eq!(duration(200_000.0), "2d");
        assert_eq!(duration(-4.0), "0s");
    }
}
