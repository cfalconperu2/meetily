// audio/meeting_detector.rs
//
// Opt-in background poller that watches for known meeting-app processes
// (Zoom, Teams, etc.) and suggests starting a recording when one appears.
//
// This is process-name detection only: it can tell "Zoom.exe is running",
// not "the user is in an active call". Apps like Zoom/Teams commonly stay
// resident in the background between calls, so this has a real false-positive
// rate -- it notifies on every (re)launch of a known app, not on every call.
// True call-state detection would need window-title or WASAPI-session
// signals, which requires the `windows` crate (not a dependency here today).
// That's why this only ever suggests a recording (event + OS notification);
// it never starts one automatically.

use log::{debug, info, warn};
use std::collections::HashSet;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Runtime};

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(8);

/// (process basename without extension, lowercase, display name)
const KNOWN_MEETING_APPS: &[(&str, &str)] = &[
    ("zoom", "Zoom"),
    ("teams", "Microsoft Teams"),
    ("ms-teams", "Microsoft Teams"),
    ("ciscowebexstart", "Cisco Webex"),
    ("webexmta", "Cisco Webex"),
    ("discord", "Discord"),
    ("slack", "Slack"),
    ("skype", "Skype"),
];

fn match_known_app(process_name_lower: &str) -> Option<&'static str> {
    // Strip a trailing ".exe" (Windows) so the table stays platform-agnostic.
    let stem = process_name_lower.strip_suffix(".exe").unwrap_or(process_name_lower);
    KNOWN_MEETING_APPS
        .iter()
        .find(|(needle, _)| *needle == stem)
        .map(|(_, display)| *display)
}

fn notify_meeting_app_detected<R: Runtime>(app: &AppHandle<R>, app_name: &str) {
    info!("🔎 Meeting app detected: {}", app_name);

    let _ = app.emit(
        "meeting-app-detected",
        serde_json::json!({ "app_name": app_name }),
    );

    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app
        .notification()
        .builder()
        .title("TBP Meetings")
        .body(format!("{} está abierto. ¿Grabar esta reunión?", app_name))
        .show()
    {
        warn!("Failed to show meeting-detected notification: {}", e);
    }
}

/// Runs for the lifetime of the app (spawned once from `.setup()`). Cheap
/// no-op ticks when the `auto_detect_meetings` preference is off or a
/// recording is already in progress.
pub async fn run_detection_loop<R: Runtime>(app: AppHandle<R>) {
    info!("🔎 Meeting detector loop started (interval={:?})", POLL_INTERVAL);

    let mut system = System::new();
    let mut notified: HashSet<String> = HashSet::new();

    loop {
        tokio::time::sleep(POLL_INTERVAL).await;

        let prefs = match super::recording_preferences::load_recording_preferences(&app).await {
            Ok(p) => p,
            Err(e) => {
                debug!("Meeting detector: failed to load preferences, skipping tick: {}", e);
                continue;
            }
        };

        if !prefs.auto_detect_meetings {
            // Reset so a later re-enable starts from a clean slate instead of
            // silently suppressing an app that was already running.
            if !notified.is_empty() {
                notified.clear();
            }
            continue;
        }

        if super::recording_commands::is_recording().await {
            continue;
        }

        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new(),
        );

        let mut currently_matched: HashSet<String> = HashSet::new();
        for process in system.processes().values() {
            let name_lower = process.name().to_string_lossy().to_lowercase();
            if let Some(display_name) = match_known_app(&name_lower) {
                currently_matched.insert(display_name.to_string());
            }
        }

        // New detections: transition 0 -> 1.
        for display_name in currently_matched.difference(&notified) {
            notify_meeting_app_detected(&app, display_name);
        }

        // Processes that disappeared: allow re-notification if they relaunch.
        notified.retain(|name| currently_matched.contains(name));
        notified.extend(currently_matched);
    }
}
