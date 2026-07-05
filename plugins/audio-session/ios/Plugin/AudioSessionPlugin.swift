import Foundation
import Capacitor
import AVFoundation
import WebKit

/// Audio-session policy for Zoomies.
///
/// `configure()` puts the app's AVAudioSession in `.ambient` with
/// `.mixWithOthers`, so game audio coexists with the player's own
/// music/podcast instead of killing it, and the hardware silent switch is
/// respected (both are what players expect from a casual game).
///
/// `isOtherAudioPlaying()` reports whether the player already has audio
/// rolling, so the game can keep its music silent and let SFX ride on top —
/// the "their audio wins" policy in src/platform/native.js.
@objc(AudioSessionPlugin)
public class AudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioSessionPlugin"
    public let jsName = "AudioSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isOtherAudioPlaying", returnType: CAPPluginReturnPromise)
    ]

    // Snapshot taken at plugin load — before the web view has executed any game
    // JS. Once the game boots, its OWN audio (WebKit runs web audio in helper
    // processes) reads as "other audio playing" from this process, so a live
    // query self-triggers the mute-music policy. Only the launch snapshot can
    // answer "was the PLAYER already listening to something?".
    private var otherAudioAtLaunch = false

    override public func load() {
        otherAudioAtLaunch = AVAudioSession.sharedInstance().isOtherAudioPlaying
        // Purge any service worker registered by older builds of the app. A
        // stale SW serves a weeks-old cached page over the freshly-synced
        // bundle, and the JS-side cleanup can never run because the stale SW
        // serves the stale HTML that predates the cleanup — only native code,
        // running before the web view navigates, can break that loop.
        // localStorage/IndexedDB (settings, garage, PBs) are untouched.
        DispatchQueue.main.async {
            let types: Set<String> = [WKWebsiteDataTypeServiceWorkerRegistrations]
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: Date.distantPast) {}
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.ambient, options: [.mixWithOthers])
            try session.setActive(true)
            call.resolve()
        } catch {
            call.reject("audio session configure failed: \(error.localizedDescription)")
        }
    }

    @objc func isOtherAudioPlaying(_ call: CAPPluginCall) {
        // "playing" is the LAUNCH SNAPSHOT (see load()) — a live read here is
        // polluted by the game's own web audio. "now" (the live value) is
        // included for log diagnostics only. The secondaryAudioShouldBeSilencedHint
        // was dropped earlier: it reads true whenever another app merely HOLDS
        // a non-mixable session (e.g. a paused podcast).
        call.resolve([
            "playing": otherAudioAtLaunch,
            "now": AVAudioSession.sharedInstance().isOtherAudioPlaying
        ])
    }
}
