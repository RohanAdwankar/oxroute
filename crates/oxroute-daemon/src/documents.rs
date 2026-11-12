//! Immutable submitted-file reviews. Human decisions never authorize Git publication.
use super::*;
use oxroute_core::model::{now, EntryKind, Event};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, LazyLock, Weak}};
use tokio::{process::Command, sync::Mutex};

macro_rules! ensure {
    ($condition:expr, $($message:tt)*) => { if !$condition { return Err(anyhow::anyhow!($($message)*).into()); } };
}
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
static RENDER: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static CAPTURES: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    id: String,
    agent_id: String,
    name: String,
    sha256: String,
    extension: String,
    pages: usize,
    text: Option<String>,
    status: String,
    feedback: String,
    annotations: serde_json::Value,
    decided_at: Option<f64>,
    #[serde(default)]
    request_id: String,
}
#[derive(Deserialize)]
pub struct Submission { path: String, #[serde(default)] attachment: bool }

fn directory(hub: &Hub, review: &Review) -> PathBuf {
    hub.config.database.parent().expect("database directory").join("document-reviews").join(&review.id)
}
fn record(hub: &Hub, agent: &str, id: &str) -> Result<Review> {
    let review: Review = serde_json::from_str(&hub.store.get(&format!("document:{id}"))?.context("No such file review")?)?;
    ensure!(review.agent_id == agent, "File review belongs to another conversation");
    Ok(review)
}
async fn run(mut command: Command) -> Result<String> {
    command.kill_on_drop(true).env("LC_ALL", "C");
    let output = tokio::time::timeout(Duration::from_secs(90), command.output()).await.context("Document rendering timed out")??;
    ensure!(output.status.success(), "Document rendering failed: {}", String::from_utf8_lossy(&output.stderr));
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn create(State(hub): Hubs, Path(agent): Path<String>, Json(body): Json<Submission>) -> Result<Json<Review>, Failed> {
    hub.store.agent(&agent)?.context("No such agent")?;
    let root = if body.attachment { &hub.config.attachments } else { &hub.config.artifacts };
    let root = tokio::fs::canonicalize(root).await?;
    let source = tokio::fs::canonicalize(if body.attachment { root.join(&body.path) } else { PathBuf::from(&body.path) }).await?;
    ensure!(source.starts_with(&root) && source.is_file(), "File is outside submitted artifacts");
    let name = source.file_name().context("Missing filename")?.to_string_lossy().into_owned();
    let extension = source.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    ensure!(IMAGE_EXTENSIONS.contains(&extension.as_str()) || ["pdf", "pptx", "txt", "md", "csv", "tsv", "json", "yaml", "yml", "log", "rs", "py", "js", "ts", "tsx", "html", "css", "sh", "toml", "xml"].contains(&extension.as_str()), "This file format cannot be reviewed");
    // Copy and hash in one pass, so changing a source during capture cannot approve different bytes.
    let staging = hub.config.database.parent().unwrap().join("document-reviews");
    tokio::fs::create_dir_all(&staging).await?;
    let temporary = staging.join(oxroute_core::model::new_id("capture"));
    let mut input = tokio::fs::File::open(&source).await?;
    let mut output = tokio::fs::File::create(&temporary).await?;
    let mut digest = openssl::sha::Sha256::new();
    let mut buffer = vec![0; 65536];
    loop {
        let count = input.read(&mut buffer).await?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
        output.write_all(&buffer[..count]).await?;
    }
    output.flush().await?;
    drop(output);
    let sha256 = digest.finish().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let identity = format!("{agent}\0{name}\0{sha256}");
    let id = openssl::sha::sha256(identity.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
    let capture = {
        let mut locks = CAPTURES.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = locks.get(&id).and_then(Weak::upgrade).unwrap_or_else(|| Arc::new(Mutex::new(())));
        locks.insert(id.clone(), Arc::downgrade(&lock));
        lock
    };
    let _capture = capture.lock().await;
    if let Ok(review) = record(&hub, &agent, &id) {
        tokio::fs::remove_file(temporary).await?;
        return Ok(Json(review));
    }
    let mut review = Review { id, agent_id: agent, name, sha256, extension, pages: 0, text: None, status: "pending".into(), feedback: String::new(), annotations: json!([]), decided_at: None, request_id: String::new() };
    let folder = directory(&hub, &review);
    tokio::fs::create_dir_all(&folder).await?;
    let saved = folder.join(format!("source.{}", review.extension));
    tokio::fs::rename(temporary, &saved).await?;
    if ["pdf", "pptx"].contains(&review.extension.as_str()) {
        let _render = RENDER.lock().await;
        if review.extension == "pptx" {
            let profile = folder.join("profile");
            let mut command = Command::new("libreoffice");
            command.arg(format!("-env:UserInstallation=file://{}", profile.display())).args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(&folder).arg(&saved);
            run(command).await?;
        }
        let mut command = Command::new("pdfinfo");
        command.arg(folder.join("source.pdf"));
        let info = run(command).await?;
        review.pages = info.lines().find_map(|line| line.strip_prefix("Pages:").and_then(|value| value.trim().parse().ok())).context("No pages in document")?;
    } else if IMAGE_EXTENSIONS.contains(&review.extension.as_str()) {
        review.pages = 1;
    } else {
        review.text = Some(tokio::fs::read_to_string(saved).await.context("Text review requires UTF-8")?);
    }
    hub.store.set(&format!("document:{}", review.id), &serde_json::to_string(&review)?)?;

    Ok(Json(review))
}

pub async fn show(State(hub): Hubs, Path((agent, id)): Path<(String, String)>) -> Result<Json<Review>, Failed> {
    Ok(Json(record(&hub, &agent, &id)?))
}

pub async fn page(State(hub): Hubs, Path((agent, id, page)): Path<(String, String, usize)>, headers: HeaderMap) -> Result<Response, Failed> {
    let review = record(&hub, &agent, &id)?;
    ensure!(page > 0 && page <= review.pages, "No such page");
    let folder = directory(&hub, &review);
    if IMAGE_EXTENSIONS.contains(&review.extension.as_str()) {
        return attachment_response(&folder.join(format!("source.{}", review.extension)), oxroute_core::model::attachment_mime(&review.name), &headers).await;
    }
    let target = folder.join(format!("page-{page}.png"));
    {
        let _guard = RENDER.lock().await;
        if !target.exists() {
            let mut command = Command::new("pdftoppm");
            command.args(["-f", &page.to_string(), "-l", &page.to_string(), "-scale-to", "1600", "-png", "-singlefile"]).arg(folder.join("source.pdf")).arg(folder.join(format!("page-{page}")));
            run(command).await?;
        }
    }
    attachment_response(&target, "image/png", &headers).await
}

pub async fn original(State(hub): Hubs, Path((agent, id)): Path<(String, String)>, headers: HeaderMap) -> Result<Response, Failed> {
    let review = record(&hub, &agent, &id)?;
    attachment_response(&directory(&hub, &review).join(format!("source.{}", review.extension)), oxroute_core::model::attachment_mime(&review.name), &headers).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decision { status: String, #[serde(default)] text: String, #[serde(default)] annotations: Vec<Annotation>, request_id: String }
#[derive(serde::Serialize, Deserialize)]
struct Annotation { page: usize, quote: String, region: Option<[f64; 4]>, strokes: Vec<Vec<[f64; 2]>> }

pub async fn decide(State(hub): Hubs, Path((agent, id)): Path<(String, String)>, mut multipart: Multipart) -> Result<Json<Review>, Failed> {
    let mut review = record(&hub, &agent, &id)?;
    let mut decision = None;
    let mut images = vec![];
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("decision") { decision = Some(serde_json::from_str::<Decision>(&field.text().await?)?); }
        else if field.name() == Some("files") { images.push(keep_file(&hub.config.attachments, field).await?); }
    }
    let body = decision.context("Missing decision")?;
    ensure!(["approved", "changes_requested"].contains(&body.status.as_str()) || (body.status == "replied" && IMAGE_EXTENSIONS.contains(&review.extension.as_str())), "Unknown decision");
    ensure!(!body.request_id.is_empty() && body.request_id.len() <= 100 && body.text.len() <= 32000 && body.annotations.len() <= 100, "Invalid review feedback");
    ensure!(body.status != "changes_requested" || !body.text.trim().is_empty(), "Describe the requested revision");
    for note in &body.annotations {
        ensure!(note.page <= review.pages && (review.pages == 0 || note.page > 0) && note.quote.len() <= 32000 && note.strokes.len() <= 100, "Invalid annotation");
        let coordinates = note.strokes.iter().flatten().flatten().copied().chain(note.region.iter().flatten().copied());
        ensure!(coordinates.into_iter().all(|p| p.is_finite() && (0.0..=1.0).contains(&p)) && note.strokes.iter().map(Vec::len).sum::<usize>() <= 20000, "Invalid annotation coordinates");
    }
    if review.request_id == body.request_id { return Ok(Json(review)); }
    let serialized = serde_json::to_string(&body.annotations)?;
    let message = format!("File review {}: {}\nFile: {}\nSHA-256: {}\nSaved original: {}\n\n{}\n\nPage/slide annotations (normalized coordinates): {}\nThis decision applies only to this submitted file revision and grants no Git publication permission.", review.id, body.status, review.name, review.sha256, directory(&hub, &review).join(format!("source.{}", review.extension)).display(), body.text, serialized);
    // Existing request IDs give feedback the same durable, retry-safe delivery as a chat message.
    hub.say_to_annotated(&agent, &message, images, true, "", &format!("document:{}:{}", review.id, body.request_id)).await?;
    review.request_id = body.request_id;
    review.status = body.status;
    review.feedback = body.text;
    review.annotations = serde_json::to_value(body.annotations)?;
    review.decided_at = Some(now());
    hub.store.set(&format!("document:{}", review.id), &serde_json::to_string(&review)?)?;
    let entry = hub.store.add_entry(&agent, now(), EntryKind::Notice, &format!("File review {}: {}", review.name, review.status), "", "")?;
    hub.emit(Event::Timeline { entry: Box::new(entry) });
    Ok(Json(review))
}
