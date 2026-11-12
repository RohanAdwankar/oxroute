use oxroute_core::{
    agent::{codex::CodexHarness, Harness},
    config::Config,
    next_actions,
};
#[tokio::test]
#[ignore = "requires a running, authenticated Codex app-server"]
async fn live_suggestion_transport() {
    let config = Config::load().unwrap();
    let harness = CodexHarness::new(&config);
    let prompt = next_actions::prompt(
        r#"{"conversation":[{"kind":"you","text":"Inspect the application settings"},{"kind":"said","text":"Settings inspection is finished. No changes were needed."}],"tasks":[]}"#,
    );
    let text = harness
        .oneshot(&prompt, next_actions::schema(), "/home/radwankar")
        .await
        .unwrap();
    next_actions::parse(&text).unwrap();
}
