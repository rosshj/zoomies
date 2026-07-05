import Foundation
import Capacitor
import AVFoundation

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
        // isOtherAudioPlaying only. The secondaryAudioShouldBeSilencedHint was
        // also consulted originally, but it reads true whenever another app
        // merely HOLDS a non-mixable session (e.g. a paused podcast), which
        // muted the game's music with nothing audibly playing.
        let session = AVAudioSession.sharedInstance()
        call.resolve(["playing": session.isOtherAudioPlaying])
    }
}
