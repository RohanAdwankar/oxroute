//! Stateless Streamable HTTP MCP, bound to one authenticated Oxroute sender.
use super::*;
use serde_json::Value;

pub async fn call(State(hub): Hubs, Path(agent): Path<String>, headers: HeaderMap, Json(request): Json<Value>) -> Response {
    let token=headers.get(header::AUTHORIZATION).and_then(|h|h.to_str().ok()).and_then(|h|h.strip_prefix("Bearer ")).unwrap_or("");
    if hub.authorize_agent_tool(&agent,token).is_err() {return StatusCode::UNAUTHORIZED.into_response();}
    let id=request.get("id").cloned();
    let method=request["method"].as_str().unwrap_or("");
    if id.is_none() {return StatusCode::ACCEPTED.into_response();}
    let result=match method {
        "initialize" => json!({"protocolVersion":request.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-03-26"),"capabilities":{"tools":{}},"serverInfo":{"name":"oxroute","version":env!("CARGO_PKG_VERSION")}}),
        "ping" => json!({}),
        "tools/list" => json!({"tools":oxroute_core::hub::tools::definitions()}),
        "tools/call" => {
            let name=request.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let arguments=request.pointer("/params/arguments").cloned().unwrap_or_else(||json!({}));
            let (value,error)=match hub.call_agent_tool(&agent,name,arguments).await {
                Ok(value)=>(value,false),
                Err(error)=>(json!({"status":"error","error":error.to_string()}),true),
            };
            json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":error})
        }
        _ => return Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown method"}})).into_response(),
    };
    Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}
