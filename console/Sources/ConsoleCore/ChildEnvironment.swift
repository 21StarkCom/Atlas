import Foundation

// The single builder for every NON-egress child spawn's environment.
//
// The egress capability key (`ATLAS_EGRESS_CAPABILITY_KEY`) is a provider-budget-minting credential.
// It must ride the child environment of ONLY the two egress-minting commands (`query` / `index eval`,
// injected by `EgressAction`) — never a probe, a `watch`, a read, or a privileged export/sign/authorize
// spawn. If the Console is launched from a shell that already exports the var, a naive
// `ProcessInfo.processInfo.environment` copy would forward it to every child. Routing every non-egress
// spawn through `ChildEnvironment.nonEgress` strips it structurally, so an inherited key can never leak
// into a non-egress subprocess regardless of how the Console was launched.
public enum ChildEnvironment {
    /// Build a non-egress child environment: start from `inherited` (the process environment by default),
    /// REMOVE the egress capability variable, then overlay `overlay` (e.g. the resolved binary's
    /// `baseEnv`). The overlay is applied AFTER the strip, so it can never reintroduce the key either.
    public static func nonEgress(
        inherited: [String: String] = ProcessInfo.processInfo.environment,
        overlay: [String: String] = [:]
    ) -> [String: String] {
        var e = inherited
        e.removeValue(forKey: EgressCapabilityEnvVar)
        for (k, v) in overlay {
            if k == EgressCapabilityEnvVar { continue } // a non-egress overlay may never carry the key
            e[k] = v
        }
        return e
    }
}
