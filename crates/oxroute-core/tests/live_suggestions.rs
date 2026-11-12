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

#[tokio::test]
#[ignore = "requires a running, authenticated Codex app-server"]
async fn live_card_metadata_transport() {
    let config = Config::load().unwrap();
    let harness = CodexHarness::new(&config);
    let context = "The user asked to inspect database health and monitoring. The agent finished the inspection.";
    let title = harness.metadata(&oxroute_core::naming::prompt(context, true), oxroute_core::naming::schema(), "/home/radwankar").await.unwrap();
    assert!(!oxroute_core::naming::parse(&title).is_empty());
    let response = harness.metadata(&oxroute_core::tags::prompt(context, &[]), oxroute_core::tags::schema(), "/home/radwankar").await.unwrap();
    let tags = oxroute_core::tags::parse_suggestions(&response).unwrap();
    assert!(!tags.is_empty());
}
