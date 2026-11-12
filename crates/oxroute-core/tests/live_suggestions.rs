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

#[tokio::test]
#[ignore = "requires a running, authenticated Codex app-server"]
async fn live_recommendation_learning_transport() {
    use oxroute_core::recommendations::{self, Feedback, Guidance};
    use serde_json::json;
    let config = Config::load().unwrap();
    let harness = CodexHarness::new(&config);
    let context = json!({"conversation":[{"kind":"you","text":"Inspect the storage configuration"},{"kind":"said","text":"Inspection is complete; measurements are available."}],"tasks":[]});
    let proposed = harness.oneshot(&next_actions::prompt(&context.to_string()), next_actions::schema(), "/home/radwankar").await.unwrap();
    let actions = next_actions::parse(&proposed).unwrap();
    let evidence = vec![Feedback {id:1, context:context.clone(), offered:serde_json::to_value(actions.actions).unwrap(), actual:json!({"selected":null,"message":"Prefer showing the measurements before proposing a change"})}];
    let previous = Guidance {revision:0,guidance:String::new()};
    let reflected = harness.metadata(&recommendations::learning_prompt(recommendations::NEXT, &previous, &evidence), recommendations::learning_schema(), "/home/radwankar").await.unwrap();
    let guidance = Guidance {revision:1,guidance:recommendations::parse_guidance(&reflected).unwrap()};
    assert!(!guidance.guidance.trim().is_empty());
    let held_out = json!({"conversation":[{"kind":"you","text":"Review network reliability"},{"kind":"said","text":"The analysis is complete and observations were recorded."}],"tasks":[]});
    let updated = harness.oneshot(&recommendations::apply(&next_actions::prompt(&held_out.to_string()), &guidance),next_actions::schema(),"/home/radwankar").await.unwrap();
    next_actions::parse(&updated).unwrap();
    let ids = vec![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string()];
    let inbox = json!({"item":{"text":"Review the storage capacity report"},"agents":[{"id":ids[0],"name":"Storage capacity"},{"id":ids[1],"name":"Frontend layout"}]});
    let routed = harness.metadata(&recommendations::routing_prompt(&inbox),recommendations::routing_schema(),"/home/radwankar").await.unwrap();
    let choice = recommendations::parse_routing(&routed,&ids).unwrap();
    let evidence = vec![Feedback {id:2,context:inbox,offered:serde_json::to_value(choice).unwrap(),actual:json!({"action":"existing","agentIds":[ids[0]]})}];
    let reflected = harness.metadata(&recommendations::learning_prompt(recommendations::ROUTING,&previous,&evidence),recommendations::learning_schema(),"/home/radwankar").await.unwrap();
    recommendations::parse_guidance(&reflected).unwrap();
}
