//! A readline binding runs commands in the pane's Bash without consuming a user draft.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub after: u64,
}

pub fn directory(database: &Path, terminal: &str) -> PathBuf {
    database
        .parent()
        .unwrap()
        .join("terminal-shells")
        .join(terminal)
}

pub fn prepare(root: &Path) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(root)?;
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    let rc = root.join("bashrc");
    std::fs::write(&rc, include_str!("terminal-shell.bash"))?;
    Ok(rc)
}

pub fn finished(root: &Path, execution: &Execution) -> Result<Option<i32>> {
    match std::fs::read_to_string(root.join(format!("{}.done", execution.id))) {
        Ok(code) => Ok(Some(
            code.trim().parse().context("Invalid shell completion")?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn forget(root: &Path, execution: &Execution) -> Result<()> {
    for extension in ["command", "done", "tmp"] {
        match std::fs::remove_file(root.join(format!("{}.{}", execution.id, extension))) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
