//! Read-only Linux process evidence, compared with the browser's own baseline.
use serde::Serialize;
use std::{collections::HashMap, fs, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Isolation {
    pub status: &'static str,
    pub requested: bool,
    pub browser_pid: u32,
    pub renderers: Vec<Renderer>,
    pub errors: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renderer {
    pid: u32,
    seccomp: Option<u32>,
    seccomp_filters: Option<u32>,
    no_new_privileges: Option<u32>,
    effective_capabilities: Option<u64>,
    nested_pid_namespace: bool,
    separate_user_namespace: Option<bool>,
    separate_network_namespace: Option<bool>,
    verified: bool,
}
impl Renderer {
    fn isolated(&self, browser_filters: Option<u32>) -> bool {
        self.seccomp == Some(2)
            && self
                .seccomp_filters
                .zip(browser_filters)
                .is_some_and(|(renderer, browser)| renderer > browser)
            && self.no_new_privileges == Some(1)
            && self.effective_capabilities == Some(0)
            && self.nested_pid_namespace
            && self.separate_network_namespace != Some(false)
    }
}

struct Process {
    pid: u32,
    status: HashMap<String, String>,
}
impl Process {
    fn read(root: &Path, pid: u32) -> std::io::Result<Self> {
        let directory = root.join(pid.to_string());
        let status: HashMap<_, _> = fs::read_to_string(directory.join("status"))?
            .lines()
            .filter_map(|line| {
                line.split_once(':')
                    .map(|(key, value)| (key.into(), value.trim().into()))
            })
            .collect();
        Ok(Self { pid, status })
    }
    fn number(&self, field: &str) -> Option<u32> {
        self.status.get(field)?.parse().ok()
    }
    fn depth(&self) -> Option<usize> {
        Some(self.status.get("NSpid")?.split_whitespace().count())
    }
}

fn separate_namespace(root: &Path, browser: u32, renderer: u32, namespace: &str) -> Option<bool> {
    let link = |pid| fs::read_link(root.join(format!("{pid}/ns/{namespace}"))).ok();
    Some(link(browser)? != link(renderer)?)
}

pub fn inspect(browser_pid: u32, renderer_pids: Vec<u32>, requested: bool) -> Isolation {
    let mut result = Isolation {
        status: "unverified",
        requested,
        browser_pid,
        renderers: vec![],
        errors: vec![],
    };
    if !cfg!(target_os = "linux") {
        result.status = "unsupported";
        return result;
    }
    let root = Path::new("/proc");
    let browser = match Process::read(root, browser_pid) {
        Ok(browser) => browser,
        Err(error) => {
            result
                .errors
                .push(format!("Browser process evidence unavailable: {error}"));
            return result;
        }
    };
    for pid in renderer_pids {
        let process = match Process::read(root, pid) {
            Ok(process) => process,
            Err(error) => {
                result
                    .errors
                    .push(format!("Renderer {pid} evidence unavailable: {error}"));
                continue;
            }
        };
        let seccomp = process.number("Seccomp");
        let seccomp_filters = process.number("Seccomp_filters");
        let no_new_privileges = process.number("NoNewPrivs");
        let effective_capabilities = process
            .status
            .get("CapEff")
            .and_then(|value| u64::from_str_radix(value, 16).ok());
        let nested_pid_namespace = process
            .depth()
            .zip(browser.depth())
            .is_some_and(|(renderer, browser)| renderer > browser);
        let separate_user_namespace = separate_namespace(root, browser_pid, process.pid, "user");
        let separate_network_namespace = separate_namespace(root, browser_pid, process.pid, "net");
        // Seccomp alone can be inherited from the host/container. Require an
        // added filter and a deeper PID namespace as independent evidence.
        let mut renderer = Renderer {
            pid: process.pid,
            seccomp,
            seccomp_filters,
            no_new_privileges,
            effective_capabilities,
            nested_pid_namespace,
            separate_user_namespace,
            separate_network_namespace,
            verified: false,
        };
        renderer.verified = requested && renderer.isolated(browser.number("Seccomp_filters"));
        result.renderers.push(renderer);
    }
    result.renderers.sort_by_key(|process| process.pid);
    result.status = if !requested {
        "disabled"
    } else if !result.errors.is_empty() {
        "unverified"
    } else if result.renderers.is_empty() {
        "starting"
    } else if result.renderers.iter().all(|process| process.verified) {
        "verified"
    } else {
        "unverified"
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_requires_independent_renderer_restrictions() {
        for baseline in [0, 2, 5] {
            let mut renderer = Renderer {
                pid: 1,
                seccomp: Some(2),
                seccomp_filters: Some(baseline + 1),
                no_new_privileges: Some(1),
                effective_capabilities: Some(0),
                nested_pid_namespace: true,
                separate_user_namespace: None,
                separate_network_namespace: None,
                verified: false,
            };
            assert!(
                renderer.isolated(Some(baseline)),
                "Unreadable namespace links do not erase the readable PID namespace evidence"
            );
            renderer.seccomp_filters = Some(baseline);
            assert!(
                !renderer.isolated(Some(baseline)),
                "An inherited host filter alone is insufficient"
            );
            renderer.seccomp_filters = Some(baseline + 1);
            renderer.nested_pid_namespace = false;
            assert!(
                !renderer.isolated(Some(baseline)),
                "Seccomp without namespace isolation is insufficient"
            );
            renderer.nested_pid_namespace = true;
            renderer.effective_capabilities = Some(1);
            assert!(
                !renderer.isolated(Some(baseline)),
                "Renderer capabilities must be dropped"
            );
            renderer.effective_capabilities = None;
            assert!(
                !renderer.isolated(Some(baseline)),
                "Missing process evidence cannot verify isolation"
            );
        }
    }
}
