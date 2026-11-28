//! Immutable submitted-file reviews. Human decisions never authorize Git publication.
use super::*;
use crate::review::{File, Subject};
use oxroute_core::model::{now, EntryKind, Event};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, LazyLock, Weak}};
use tokio::{process::Command, sync::Mutex};

macro_rules! ensure {
    ($condition:expr, $($message:tt)*) => { if !$condition { return Err(anyhow::anyhow!($($message)*).into()); } };
}
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
static RENDER: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static CAPTURES: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn directory(hub: &Hub, id: &str) -> PathBuf {
    hub.config.database.parent().expect("database directory").join("document-reviews").join(id)
}
fn file_review(hub: &Hub, agent: &str, id: &str, inherited: bool) -> Result<(Review, File)> {
    let review = review_record(hub, agent, id, inherited)?.0;
    let file = review.file()?.clone();
    Ok((review, file))
}
async fn run(mut command: Command) -> Result<String> {
    command.kill_on_drop(true).env("LC_ALL", "C");
    let output = tokio::time::timeout(Duration::from_secs(90), command.output()).await.context("Document rendering timed out")??;
    ensure!(output.status.success(), "Document rendering failed: {}", String::from_utf8_lossy(&output.stderr));
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Capture a submitted file as a review; returns whether this call created it.
pub async fn create(hub: &Arc<Hub>, agent: &str, title: String, path: &str, attachment: bool) -> Result<(Review, bool)> {
    let expanded = match path.strip_prefix("~/") {
        Some(rest) if !attachment => PathBuf::from(std::env::var_os("HOME").context("No home directory")?).join(rest),
        _ => PathBuf::from(path),
    };
    let source = if attachment {
        let root = tokio::fs::canonicalize(&hub.config.attachments).await?;
        let source = tokio::fs::canonicalize(root.join(&expanded)).await.context("No such attachment")?;
        ensure!(source.starts_with(&root), "File is outside attachments");
        source
    } else {
        ensure!(expanded.is_absolute(), "Use an absolute path");
        tokio::fs::canonicalize(&expanded).await.with_context(|| format!("Cannot read {path}"))?
    };
    ensure!(source.is_file(), "{path} is not a file");
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
    if let Ok((review, _)) = review_record(hub, agent, &id, false) {
        tokio::fs::remove_file(temporary).await?;
        return Ok((review, false));
    }
    let mut file = File { name, sha256, extension, pages: 0, text: None };
    let folder = directory(hub, &id);
    tokio::fs::create_dir_all(&folder).await?;
    let saved = folder.join(format!("source.{}", file.extension));
    tokio::fs::rename(temporary, &saved).await?;
    if ["pdf", "pptx"].contains(&file.extension.as_str()) {
        let _render = RENDER.lock().await;
        if file.extension == "pptx" {
            let profile = folder.join("profile");
            let mut command = Command::new("libreoffice");
            command.arg(format!("-env:UserInstallation=file://{}", profile.display())).args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(&folder).arg(&saved);
            run(command).await?;
        }
        let mut command = Command::new("pdfinfo");
        command.arg(folder.join("source.pdf"));
        let info = run(command).await?;
        file.pages = info.lines().find_map(|line| line.strip_prefix("Pages:").and_then(|value| value.trim().parse().ok())).context("No pages in document")?;
    } else if IMAGE_EXTENSIONS.contains(&file.extension.as_str()) {
        file.pages = 1;
    } else {
        file.text = Some(tokio::fs::read_to_string(saved).await.context("Text review requires UTF-8")?);
    }
    let review = Review::new(id, agent.into(), title, String::new(), Subject::File(file));
    crate::announce(hub, &review)?;
    Ok((review, true))
}

pub async fn page(State(hub): Hubs, Path((agent, id, page)): Path<(String, String, usize)>, headers: HeaderMap) -> Result<Response, Failed> {
    let (_, file) = file_review(&hub, &agent, &id, true)?;
    ensure!(page > 0 && page <= file.pages, "No such page");
    let folder = directory(&hub, &id);
    if IMAGE_EXTENSIONS.contains(&file.extension.as_str()) {
        return attachment_response(&folder.join(format!("source.{}", file.extension)), oxroute_core::model::attachment_mime(&file.name), &headers).await;
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
    let (_, file) = file_review(&hub, &agent, &id, true)?;
    attachment_response(&directory(&hub, &id).join(format!("source.{}", file.extension)), oxroute_core::model::attachment_mime(&file.name), &headers).await
}

#[derive(serde::Serialize, Deserialize)]
struct Annotation {
    #[serde(default)] style: MarkerStyle,
    page: usize, quote: String, region: Option<[f64; 4]>, strokes: Vec<Vec<[f64; 2]>>,
    #[serde(default)] comment: String,
    #[serde(default)] labels: Vec<TextMark>,
}
#[derive(serde::Serialize, Deserialize)]
struct MarkerStyle { color: String, width: f64 }
impl Default for MarkerStyle {
    fn default() -> Self { Self { color: "#d23c2e".into(), width: 1.0 } }
}
#[derive(serde::Serialize, Deserialize)]
struct TextMark { at: [f64; 2], text: String }

/// Decide a file review; an approval authorizes nothing beyond the submitted bytes.
pub async fn decide(hub: &Arc<Hub>, mut review: Review, body: DecisionBody, images: Vec<String>) -> anyhow::Result<serde_json::Value> {
    let file = review.file()?.clone();
    let is_image = IMAGE_EXTENSIONS.contains(&file.extension.as_str());
    ensure!(["approved", "changes_requested"].contains(&body.status.as_str()) || (body.status == "replied" && is_image), "Unknown decision");
    ensure!(body.revision == file.sha256, "Decision must match this submitted file revision");
    ensure!(body.annotations.len() <= 100, "Invalid review feedback");
    let notes = body.annotations.iter().cloned().map(serde_json::from_value::<Annotation>).collect::<Result<Vec<_>, _>>()?;
    ensure!(body.status != "changes_requested" || !body.text.trim().is_empty() || notes.iter().any(|note| !note.comment.trim().is_empty()), "Describe the requested revision");
    for note in &notes {
        ensure!(note.style.color.strip_prefix('#').is_some_and(|color| color.len() == 6 && color.bytes().all(|ch| ch.is_ascii_hexdigit())) && note.style.width.is_finite() && (0.1..=10.0).contains(&note.style.width), "Invalid marker style");
        ensure!(note.page <= file.pages && (file.pages == 0 || note.page > 0) && note.quote.len() <= 32000 && note.strokes.len() <= 100 && note.comment.len() <= 32000 && note.labels.len() <= 100 && note.labels.iter().all(|label| label.text.len() <= 2000), "Invalid annotation");
        let coordinates = note.strokes.iter().flatten().flatten().copied().chain(note.region.iter().flatten().copied()).chain(note.labels.iter().flat_map(|label| label.at));
        ensure!(coordinates.into_iter().all(|p| p.is_finite() && (0.0..=1.0).contains(&p)) && note.strokes.iter().map(Vec::len).sum::<usize>() <= 20000, "Invalid annotation coordinates");
    }
    let annotations = notes.iter().map(serde_json::to_value).collect::<Result<Vec<_>, _>>()?;
    if let Some(saved) = review.feedback.iter().find(|saved| saved.request_id == body.request_id) {
        ensure!(saved.text == body.text && saved.annotations == annotations, "requestId already belongs to different feedback");
        return crate::observed_review(hub, review, false).await;
    }
    let comments = notes.iter().enumerate().filter(|(_, note)| note.quote != "Drawing" || (note.region.is_none() && note.strokes.is_empty() && note.labels.is_empty())).map(|(index, note)| {
        let context = if note.region.is_some() { format!("Selection {}", index+1) } else { note.quote.clone() };
        format!("{}{}{}", if note.page > 0 { format!("Page {}: ", note.page) } else { String::new() }, context, if note.comment.is_empty() { String::new() } else { format!("\n{}", note.comment) })
    }).collect::<Vec<_>>().join("\n\n");
    let status = match body.status.as_str() { "approved" => "Approved", "changes_requested" => "Revision requested", _ => "Image reply" };
    let mut message = if body.status == "replied" { format!("{status}: {}", file.name) }
        else { format!("[{status}: {}](/api/agents/{}/reviews/{})", file.name.replace('[', "").replace(']', ""), review.agent_id, review.id) };
    for text in [&body.text, &comments] { if !text.trim().is_empty() { message.push_str("\n\n"); message.push_str(text); } }
    if body.status != "replied" { message.push_str("\n\nThis decision applies only to this submitted file revision and grants no Git publication permission."); }

    // Existing request IDs give feedback the same durable, retry-safe delivery as a chat message.
    hub.say_to_annotated(&review.agent_id, &message, images, true, "", &format!("review-decision:{}:{}", review.id, body.request_id)).await?;
    let at = now();
    review.decision = Some(Decision { status: body.status.clone(), at, request_id: body.request_id.clone() });
    review.feedback.push(Feedback { request_id: body.request_id, at, revision: file.sha256, text: body.text, annotations });
    hub.store.set(&format!("review:{}", review.id), &serde_json::to_string(&review)?)?;
    if body.status == "replied" {
        hub.emit(Event::Sync);
    } else {
        let entry = hub.store.add_entry(&review.agent_id, at, EntryKind::Notice, &format!("File review {}: {}", file.name, body.status), "", "")?;
        hub.emit(Event::Timeline { entry: Box::new(entry) });
    }
    crate::observed_review(hub, review, false).await
}
