//! Drawing.
//!
//! The layout is the mockup's: a top bar with the mode toggle and the
//! counters, the inbox down the left, the fleet in the main column. Nothing
//! here reads or writes state -- it takes `App` and paints it -- so the key
//! handling and the rendering can be reasoned about separately.

use oxroute_core::model::{Agent, EntryKind, InboxItem, InboxState};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::theme;
use crate::{App, Focus, View};

const INBOX_WIDTH: u16 = 42;

pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // top bar
            Constraint::Min(3),    // body
            Constraint::Length(1), // key hints
        ])
        .split(area);

    top_bar(frame, rows[0], app);

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(INBOX_WIDTH), Constraint::Min(20)])
        .split(rows[1]);

    inbox(frame, columns[0], app);
    match &app.view {
        View::Fleet => fleet(frame, columns[1], app, None),
        View::Routing { signal } => fleet(frame, columns[1], app, Some(signal)),
        View::Agent(_) => agent_detail(frame, columns[1], app),
    }
    hints(frame, rows[2], app);

    if let Some(prompt) = &app.prompt {
        prompt_bar(frame, area, prompt);
    }
    if app.help {
        help(frame, area);
    }
}

fn top_bar(frame: &mut Frame, area: Rect, app: &App) {
    let waiting = app.waiting().len();
    let working = app
        .snapshot
        .agents
        .iter()
        .filter(|a| a.status.as_str() == "working")
        .count();
    let stalled = app
        .snapshot
        .agents
        .iter()
        .filter(|a| a.status.as_str() == "stalled")
        .count();

    let mode = if app.snapshot.mode == "ask" {
        Span::styled(" ask me first ", theme::on(theme::ACCENT))
    } else {
        Span::styled(" routes on its own ", theme::on(theme::INFO))
    };

    let mut spans = vec![
        Span::styled("oxroute", theme::strong()),
        Span::raw("  "),
        mode,
        Span::raw("   "),
        Span::styled(format!("{waiting}"), theme::on(theme::WARN)),
        Span::styled(" waiting", theme::dim()),
        Span::raw("   "),
        Span::styled(format!("{working}"), theme::on(theme::OK)),
        Span::styled(" working", theme::dim()),
    ];
    if stalled > 0 {
        spans.push(Span::raw("   "));
        spans.push(Span::styled(format!("{stalled}"), theme::on(theme::BAD)));
        spans.push(Span::styled(" stalled", theme::dim()));
    }
    if let Some(notice) = app.live_notice() {
        spans.push(Span::raw("   "));
        spans.push(Span::styled(notice.to_string(), theme::on(theme::ACCENT)));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn inbox(frame: &mut Frame, area: Rect, app: &App) {
    let focused = app.focus == Focus::Inbox;
    let block = panel("inbox", focused);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if app.snapshot.inbox.is_empty() {
        frame.render_widget(
            Paragraph::new("nothing has arrived yet").style(theme::faint()),
            inner,
        );
        return;
    }

    let width = inner.width.saturating_sub(1) as usize;
    let items: Vec<ListItem> = app
        .snapshot
        .inbox
        .iter()
        .map(|item| inbox_row(item, width, app))
        .collect();

    let mut state = ListState::default();
    state.select(Some(app.inbox_cursor));
    frame.render_stateful_widget(
        List::new(items).highlight_style(theme::cursor()),
        inner,
        &mut state,
    );
}

fn inbox_row<'a>(item: &'a InboxItem, width: usize, app: &App) -> ListItem<'a> {
    let waiting = item.state == InboxState::Waiting;
    let body_style = if waiting { theme::text() } else { theme::faint() };

    let header = Line::from(vec![
        Span::styled(clock(item.signal.at), theme::faint()),
        Span::raw(" "),
        Span::styled(item.signal.source.clone(), theme::dim()),
        Span::raw(" "),
        Span::styled(item.signal.label.clone(), theme::faint()),
    ]);

    let body = Line::from(Span::styled(
        clip(&flatten(&item.signal.text), width),
        body_style,
    ));

    let footer = if waiting {
        let hint = match &item.suggested {
            Some(id) => format!(
                "→ {}",
                app.snapshot
                    .agents
                    .iter()
                    .find(|a| &a.id == id)
                    .map(|a| a.name.as_str())
                    .unwrap_or("an agent")
            ),
            None => "unrouted".to_string(),
        };
        Line::from(Span::styled(clip(&hint, width), theme::on(theme::WARN)))
    } else {
        let color = if item.outcome.starts_with("discard") {
            theme::FAINT
        } else {
            theme::OK
        };
        Line::from(Span::styled(clip(&item.outcome, width), theme::on(color)))
    };

    ListItem::new(vec![header, body, footer, Line::raw("")])
}

fn fleet(frame: &mut Frame, area: Rect, app: &App, routing: Option<&str>) {
    let focused = app.focus == Focus::Fleet;
    let title = match routing {
        Some(signal) => {
            let text = app
                .snapshot
                .inbox
                .iter()
                .find(|i| i.signal.id == signal)
                .map(|i| flatten(&i.signal.text))
                .unwrap_or_default();
            format!("send this to — {}", clip(&text, 60))
        }
        None => "fleet".to_string(),
    };
    let block = panel(&title, focused);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if app.snapshot.agents.is_empty() {
        frame.render_widget(
            Paragraph::new(
                "no agents yet\n\nsend yourself a message in Slack, or press n on an inbox item",
            )
            .style(theme::faint())
            .wrap(Wrap { trim: true }),
            inner,
        );
        return;
    }

    let width = inner.width.saturating_sub(1) as usize;
    let items: Vec<ListItem> = app
        .snapshot
        .agents
        .iter()
        .map(|agent| agent_row(agent, width, routing.is_some(), app.ticked.contains(&agent.id)))
        .collect();

    let mut state = ListState::default();
    state.select(Some(app.fleet_cursor));
    frame.render_stateful_widget(
        List::new(items).highlight_style(theme::cursor()),
        inner,
        &mut state,
    );
}

fn agent_row(agent: &Agent, width: usize, routing: bool, ticked: bool) -> ListItem<'static> {
    let color = theme::status_color(agent.status.as_str());
    let mut header = Vec::new();
    if routing {
        header.push(Span::styled(
            if ticked { "[x] " } else { "[ ] " },
            if ticked { theme::strong() } else { theme::faint() },
        ));
    }
    header.push(Span::styled("● ", theme::on(color)));
    header.push(Span::styled(agent.name.clone(), theme::strong()));
    header.push(Span::raw("  "));
    header.push(Span::styled(
        format!(
            "{} {}",
            agent.status.as_str(),
            oxroute_core::dashboard::duration(oxroute_core::model::now() - agent.updated_at)
        ),
        theme::faint(),
    ));
    header.push(Span::raw("  "));
    // Say how the next message lands before anyone sends one.
    header.push(Span::styled(
        agent.delivery().as_str().to_string(),
        theme::on(match agent.delivery() {
            oxroute_core::Delivery::Restart => theme::OK,
            oxroute_core::Delivery::Start => theme::DIM,
        }),
    ));

    let detail = if agent.activity.is_empty() {
        agent
            .stall_reason
            .clone()
            .unwrap_or_else(|| agent.model.clone())
    } else {
        agent.activity.clone()
    };

    ListItem::new(vec![
        Line::from(header),
        Line::from(Span::styled(
            format!("   {}", clip(&flatten(&detail), width.saturating_sub(3))),
            theme::dim(),
        )),
        Line::raw(""),
    ])
}

fn agent_detail(frame: &mut Frame, area: Rect, app: &App) {
    let Some(view) = &app.detail else {
        frame.render_widget(Paragraph::new("loading…").style(theme::faint()), area);
        return;
    };
    let agent = &view.agent;
    let block = panel(&format!("{} — {}", agent.name, agent.status.as_str()), true);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(inner);

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(agent.backend.as_str().to_string(), theme::on(theme::INFO)),
            Span::raw("  "),
            Span::styled(agent.model.clone(), theme::dim()),
            Span::raw("  "),
            Span::styled(view.delivery.clone(), theme::dim()),
            Span::raw("  "),
            Span::styled(flatten(&agent.activity), theme::faint()),
        ]))
        .wrap(Wrap { trim: true }),
        rows[0],
    );

    let width = rows[1].width.saturating_sub(1) as usize;
    let mut lines: Vec<Line> = Vec::new();
    for entry in &view.timeline {
        let (tag, color) = match entry.kind {
            EntryKind::Received => ("received", theme::OK),
            EntryKind::Said => ("said", theme::INK),
            EntryKind::Worked => ("worked", theme::DIM),
            EntryKind::Asked => ("asked", theme::WARN),
            EntryKind::You => ("you", theme::ACCENT),
            EntryKind::Forked => ("forked", theme::ACCENT),
            EntryKind::ForkedFrom => ("parent", theme::ACCENT),
            EntryKind::Merged | EntryKind::MergedInto => ("merged", theme::ACCENT),
            EntryKind::Notice => ("note", theme::FAINT),
            EntryKind::Review => ("review", theme::ACCENT),
        };
        lines.push(Line::from(vec![
            Span::styled(clock(entry.at), theme::faint()),
            Span::raw(" "),
            Span::styled(format!("{tag:<9}"), theme::on(color)),
            Span::styled(
                if entry.origin.is_empty() {
                    String::new()
                } else {
                    format!("← {}", entry.origin)
                },
                theme::faint(),
            ),
        ]));
        for chunk in wrap(&entry.text, width.saturating_sub(10)) {
            lines.push(Line::from(Span::styled(
                format!("          {chunk}"),
                theme::text(),
            )));
        }
        lines.push(Line::raw(""));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("nothing yet", theme::faint())));
    }

    frame.render_widget(
        Paragraph::new(lines).scroll((app.timeline_scroll, 0)),
        rows[1],
    );
}

fn hints(frame: &mut Frame, area: Rect, app: &App) {
    let keys: &[(&str, &str)] = match (&app.view, app.focus) {
        (View::Routing { .. }, _) => &[
            ("space", "tick"),
            ("↵", "send"),
            ("n", "new agent"),
            ("d", "discard"),
            ("esc", "back"),
        ],
        (View::Agent(_), _) => &[
            ("i", "say"),
            ("x", "stop"),
            ("f", "fork"),
            ("r", "rename"),
            ("esc", "back"),
        ],
        (_, Focus::Inbox) => &[
            ("↵", "route"),
            ("a", "add"),
            ("n", "new agent"),
            ("d", "discard"),
            ("tab", "fleet"),
            ("m", "mode"),
            ("?", "keys"),
        ],
        (_, Focus::Fleet) => &[
            ("↵", "open"),
            ("i", "say"),
            ("x", "stop"),
            ("f", "fork"),
            ("tab", "inbox"),
            ("?", "keys"),
        ],
    };
    let mut spans = Vec::new();
    for (key, label) in keys {
        spans.push(Span::styled(format!(" {key} "), theme::on(theme::INK)));
        spans.push(Span::styled(format!("{label}   "), theme::faint()));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn prompt_bar(frame: &mut Frame, area: Rect, prompt: &crate::Prompt) {
    let row = Rect {
        x: area.x,
        y: area.height.saturating_sub(2),
        width: area.width,
        height: 1,
    };
    frame.render_widget(Clear, row);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(format!(" {} ", prompt.label), theme::on(theme::ACCENT)),
            Span::raw(" "),
            Span::styled(prompt.value.clone(), theme::text()),
            Span::styled("▌", theme::on(theme::ACCENT)),
        ])),
        row,
    );
}

fn help(frame: &mut Frame, area: Rect) {
    let text = "\
inbox                          fleet
  ↵    route this signal         ↵   open the agent
  a    add something yourself    i   say something to it
  n    start a new agent for it  x   stop the running turn
  d    discard it                f   fork it
                                 r   rename it

anywhere
  tab  switch column       j k / ↑ ↓  move        g G  top / bottom
  m    ask-first or auto   R          resync      esc  back
  q    quit                ?          this";

    let width = 62.min(area.width.saturating_sub(4));
    let height = 16.min(area.height.saturating_sub(2));
    let panel = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    };
    frame.render_widget(Clear, panel);
    frame.render_widget(
        Paragraph::new(text)
            .style(theme::text())
            .block(panel_block("keys")),
        panel,
    );
}

fn panel(title: &str, focused: bool) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { theme::INK } else { theme::RULE }))
        .title(Span::styled(
            format!(" {title} "),
            if focused { theme::strong() } else { theme::dim() },
        ))
}

fn panel_block(title: &str) -> Block<'static> {
    panel(title, true)
}

/// Collapse a multi-line message onto one line, so a shell transcript pasted
/// into Slack does not take over the list.
fn flatten(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= width {
        return text.to_string();
    }
    let head: String = text.chars().take(width.saturating_sub(1)).collect();
    format!("{head}…")
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let mut lines = Vec::new();
    for raw in text.lines().take(24) {
        let mut current = String::new();
        for word in raw.split_whitespace() {
            if !current.is_empty() && current.chars().count() + 1 + word.chars().count() > width {
                lines.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            // A single token longer than the line -- a URL, a path -- is cut
            // rather than allowed to overflow the pane.
            if word.chars().count() > width {
                current.push_str(&clip(word, width));
            } else {
                current.push_str(word);
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
    }
    lines
}

/// Wall-clock time of day, which is what a person actually wants to compare
/// against their own memory of when something happened.
fn clock(at: f64) -> String {
    let seconds = at as i64;
    let day = seconds.rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", day / 3600, (day % 3600) / 60, day % 60)
}
