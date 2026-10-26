use anyhow::{bail, Context, Result};
use clap::{Arg, ArgAction, ArgMatches, Command};
use reqwest::{Client, Method, Url};
use serde_json::{json, Map, Value};
use std::io::Write;

#[derive(Clone)]
struct Operation { group: String, name: String, path: String, method: String, definition: Value }

fn operations(schema: &Value) -> Vec<Operation> {
    schema["paths"].as_object().into_iter().flatten().flat_map(|(path, methods)| {
        methods.as_object().into_iter().flatten().filter_map(move |(method, definition)| {
            let (group, name) = definition["operationId"].as_str()?.split_once('.')?;
            Some(Operation { group: group.into(), name: name.into(), path: path.clone(), method: method.into(), definition: definition.clone() })
        })
    }).collect()
}

fn resolve<'a>(schema: &'a Value, value: &'a Value) -> &'a Value {
    value["$ref"].as_str().and_then(|reference| reference.strip_prefix('#'))
        .and_then(|pointer| schema.pointer(pointer)).unwrap_or(value)
}

fn body_schema<'a>(schema: &'a Value, operation: &'a Operation) -> &'a Value {
    resolve(schema, &operation.definition["requestBody"]["content"]["application/json"]["schema"])
}

fn field_type(field: &Value) -> Option<&str> {
    field["type"].as_str().or_else(|| field["type"].as_array()?.iter()
        .find_map(|kind| kind.as_str().filter(|kind| *kind != "null")))
        .or_else(|| field["anyOf"].as_array()?.iter().find_map(field_type))
}

fn flag(name: &str) -> String {
    name.chars().flat_map(|character| if character.is_uppercase() { vec!['-', character.to_ascii_lowercase()] } else { vec![character] }).collect()
}

fn command(schema: &Value, operations: &[Operation], actor: Option<&str>) -> Command {
    let mut root = Command::new("oxroute-agent").about("Commands generated from the daemon's agent OpenAPI routes")
        .subcommand_required(true).arg_required_else_help(true)
        .arg(Arg::new("server").long("server").global(true).env("OXROUTE_URL").default_value("http://127.0.0.1:8787"))
        .arg(Arg::new("schema").long("schema").global(true).help("Use an explicitly exported OpenAPI file"))
        .arg(Arg::new("agent").long("agent").global(true).env("OXROUTE_AGENT_ID").help("Bind the calling session identity"))
        .arg(Arg::new("all").long("all").global(true).action(ArgAction::SetTrue).help("Include other sessions' tasks"))
        .arg(Arg::new("fields").long("fields").global(true).help("Comma-separated output fields"))
        .arg(Arg::new("filter").long("filter").global(true).action(ArgAction::Append).help("Filter returned objects by field=value"));
    let mut groups = std::collections::BTreeMap::<String, Command>::new();
    for operation in operations {
        let mut subcommand = Command::new(operation.name.clone());
        if let Some(summary) = operation.definition["summary"].as_str() { subcommand = subcommand.about(summary.to_owned()); }
        for parameter in operation.definition["parameters"].as_array().into_iter().flatten() {
            let name = parameter["name"].as_str().expect("OpenAPI parameter name");
            let bound = operation.path.starts_with("/api/agents/") && name == "id" && actor.is_some();
            subcommand = subcommand.arg(Arg::new(name.to_owned()).long(flag(name))
                .required(parameter["required"] == true && !bound));
        }
        if operation.definition.get("requestBody").is_some() {
            subcommand = subcommand.arg(Arg::new("json").long("json").help("JSON object; use @path to read a file"));
            for (name, field) in body_schema(schema, operation)["properties"].as_object().into_iter().flatten() {
                if name == "agentId" { continue; }
                let mut argument = Arg::new(name.clone()).long(flag(name));
                if operation.definition["operationId"] != "tasks.update" && body_schema(schema, operation)["required"].as_array().is_some_and(|required| required.iter().any(|field| field == name)) {
                    argument = argument.required_unless_present("json");
                }
                if let Some(description) = field["description"].as_str() { argument = argument.help(description.to_owned()); }
                subcommand = subcommand.arg(argument);
            }
        }
        let group = groups.remove(&operation.group).unwrap_or_else(|| Command::new(operation.group.clone()).subcommand_required(true));
        groups.insert(operation.group.clone(), group.subcommand(subcommand));
    }
    for group in groups.into_values() { root = root.subcommand(group); }
    root
}

fn endpoint(server: &str, operation: &Operation, arguments: &ArgMatches, actor: Option<&str>) -> Result<Url> {
    let mut url = Url::parse(server)?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| anyhow::anyhow!("Server must be an HTTP URL"))?;
        segments.clear();
        for part in operation.path.trim_start_matches('/').split('/') {
            if let Some(parameter) = part.strip_prefix('{').and_then(|part| part.strip_suffix('}')) {
                let bound = (operation.path.starts_with("/api/agents/") && parameter == "id").then_some(actor).flatten();
                let value = arguments.get_one::<String>(parameter).map(String::as_str).or(bound).context("Missing path parameter")?;
                anyhow::ensure!(![".", ".."].contains(&value), "A path parameter cannot be a relative path");
                segments.push(value);
            } else { segments.push(part); }
        }
    }
    for parameter in operation.definition["parameters"].as_array().into_iter().flatten().filter(|parameter| parameter["in"] == "query") {
        let name = parameter["name"].as_str().unwrap();
        if let Some(value) = arguments.get_one::<String>(name) { url.query_pairs_mut().append_pair(name, value); }
    }
    Ok(url)
}

fn body(schema: &Value, operation: &Operation, arguments: &ArgMatches, actor: Option<&str>) -> Result<Value> {
    let mut body = match arguments.get_one::<String>("json") {
        Some(input) => serde_json::from_str::<Value>(&if let Some(path) = input.strip_prefix('@') { std::fs::read_to_string(path)? } else { input.clone() })?
            .as_object().cloned().context("Request JSON must be an object")?,
        None => Map::new(),
    };
    for (name, field) in body_schema(schema, operation)["properties"].as_object().into_iter().flatten() {
        if name == "agentId" { continue; }
        if let Some(value) = arguments.get_one::<String>(name) {
            let field = resolve(schema, field);
            let kind = field_type(field);
            body.insert(name.clone(), if kind == Some("string") { Value::String(value.clone()) } else { serde_json::from_str(value).with_context(|| format!("--{} requires JSON", flag(name)))? });
        }
    }
    if body_schema(schema, operation)["properties"].get("agentId").is_some() {
        let actor = actor.context("Mutations require --agent or OXROUTE_AGENT_ID")?;
        anyhow::ensure!(body.get("agentId").is_none_or(|value| value == actor), "Request identity differs from --agent");
        body.insert("agentId".into(), json!(actor));
    }
    Ok(Value::Object(body))
}

async fn response(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await?;
    let status = response.status();
    let body: Value = response.json().await.context("Daemon did not return JSON")?;
    if !status.is_success() { bail!("{status}: {}", body.get("error").unwrap_or(&body)); }
    Ok(body)
}

fn output(mut value: Value, arguments: &ArgMatches, own_tasks: Option<&str>) -> Result<Value> {
    let filters: Vec<_> = arguments.get_many::<String>("filter").into_iter().flatten().map(|filter| filter.split_once('=').context("Use --filter field=value")).collect::<Result<_>>()?;
    let project = |item: Value| {
        if let Some(fields) = arguments.get_one::<String>("fields") {
            Value::Object(fields.split(',').filter_map(|field| field.split('.').try_fold(&item, |value, key| value.get(key))
                .map(|value| (field.to_string(), value.clone()))).collect())
        } else { item }
    };
    if let Some(items) = value.as_array_mut() {
        return Ok(Value::Array(std::mem::take(items).into_iter().filter(|item|
            own_tasks.is_none_or(|actor| item["agentId"] == actor) && filters.iter().all(|(key, value)| item[*key].as_str() == Some(*value)))
            .map(project).collect()));
    }
    Ok(project(value))
}

fn option(arguments: &[String], name: &str) -> Option<String> {
    arguments.iter().enumerate().find_map(|(index, value)| {
        value.strip_prefix(&format!("--{name}=")).map(String::from)
            .or_else(|| (value == &format!("--{name}")).then(|| arguments.get(index + 1).cloned()).flatten())
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let arguments: Vec<String> = std::env::args().collect();
    let server = option(&arguments, "server").or_else(|| std::env::var("OXROUTE_URL").ok()).unwrap_or_else(|| "http://127.0.0.1:8787".into());
    let actor = option(&arguments, "agent").or_else(|| std::env::var("OXROUTE_AGENT_ID").ok()).filter(|value| !value.trim().is_empty());
    let client = Client::builder().connect_timeout(std::time::Duration::from_secs(5)).build()?;
    let schema: Value = if let Some(path) = option(&arguments, "schema") { serde_json::from_str(&std::fs::read_to_string(path)?)? }
        else { response(client.get(format!("{}/api/agent-openapi.json", server.trim_end_matches('/')))).await? };
    let operations = operations(&schema);
    anyhow::ensure!(!operations.is_empty(), "No agent operations in OpenAPI schema");
    let matches = command(&schema, &operations, actor.as_deref()).get_matches_from(arguments);
    let (group, group_arguments) = matches.subcommand().unwrap();
    let (name, arguments) = group_arguments.subcommand().unwrap();
    let operation = operations.iter().find(|operation| operation.group == group && operation.name == name).unwrap();
    if operation.method != "get" { anyhow::ensure!(actor.is_some(), "Mutations require --agent or OXROUTE_AGENT_ID"); }
    let url = endpoint(&server, operation, arguments, actor.as_deref())?;
    let mut request = client.request(Method::from_bytes(operation.method.to_ascii_uppercase().as_bytes())?, url);
    if operation.definition.get("requestBody").is_some() {
        let mut body = body(&schema, operation, arguments, actor.as_deref())?;
        // Task updates preserve omitted fields; route lookup comes from OpenAPI too.
        if group == "tasks" && name == "update" {
            let explicit_blocker = body.get("blockedByTaskId").is_some();
            let list = operations.iter().find(|operation| operation.group == "tasks" && operation.name == "list").context("Task list operation is missing")?;
            let tasks = response(client.get(Url::parse(&server)?.join(&list.path)?)).await?;
            let id = arguments.get_one::<String>("id").unwrap();
            let existing = tasks.as_array().context("Task list must be an array")?.iter().find(|task| task["id"] == *id).context("No such task")?;
            for field in body_schema(&schema, operation)["properties"].as_object().into_iter().flatten().map(|(name, _)| name) {
                if body.get(field).is_none() { if let Some(value) = existing.get(field) { body[field] = value.clone(); } }
            }
            if !explicit_blocker && body["status"] != "blocked" { body["blockedByTaskId"] = json!(""); }
        }
        for field in body_schema(&schema, operation)["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            anyhow::ensure!(body.get(field).is_some(), "Missing request field: {field}");
        }
        request = request.json(&body);
    }
    let value = response(request).await?;
    let own_tasks = (group == "tasks" && name == "list" && !arguments.get_flag("all")).then_some(actor.as_deref()).flatten();
    if let Err(error) = writeln!(std::io::stdout().lock(), "{}", output(value, arguments, own_tasks)?) {
        if error.kind() != std::io::ErrorKind::BrokenPipe { return Err(error.into()); }
    }
    Ok(())
}
