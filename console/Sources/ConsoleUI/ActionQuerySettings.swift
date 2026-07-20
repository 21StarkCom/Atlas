import SwiftUI
import ConsoleCore

// P6-Task-4 — the Actions / Query / Settings surfaces (the intent-criterion-3 entry points). Both the
// Actions surface (privileged flow) and the Query surface (egress) genuinely exist and are keyboard
// drivable end to end; the Settings surface drives the probe-before-persist cutover.

// MARK: - Actions surface

/// A descriptor-driven operand form. The Actions surface builds its controls from an `OperationDescriptor`
/// (never a hand-built per-command form), splitting operands into focused-object fields (pre-filled from
/// the current selection) and operator-entry fields, and assembling the `(FocusContext, entry)` pair the
/// router binds. `constant` operands are Console-pinned by the router and need no UI.
public struct ActionOperandForm: Equatable, Sendable {
    public struct Field: Identifiable, Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            /// Pre-filled from the current selection; the associated string is the `FocusContext` key.
            case focused(field: String)
            case operatorText
            case operatorToggle
        }
        public let id: String       // operand name
        public let name: String
        public let label: String
        public let kind: Kind
        public let required: Bool
    }
    public let op: String
    public let fields: [Field]

    public init(descriptor: OperationDescriptor) {
        op = descriptor.command
        fields = descriptor.operands.compactMap { operand -> Field? in
            let required = operand.requirement == .required
            switch operand.source {
            case .constant:
                return nil   // Console-pinned by the router; no operator control
            case .focusedObject(let key):
                return Field(id: operand.name, name: operand.name,
                             label: "\(operand.name) (from selection)",
                             kind: .focused(field: key), required: required)
            case .operatorEntry:
                let isToggle: Bool = { if case .boolean = operand.kind { return true }; return false }()
                return Field(id: operand.name, name: operand.name, label: operand.name,
                             kind: isToggle ? .operatorToggle : .operatorText, required: required)
            }
        }
    }

    /// Seed the editable values from the current selection (focused fields only).
    public func seededValues(selection: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for f in fields {
            if case .focused(let key) = f.kind, let v = selection[key] { out[f.name] = v }
        }
        return out
    }

    /// Re-seed the FOCUSED fields from a changed selection while preserving operator-entered fields.
    ///
    /// The focused operands describe the object the operator picked (`runId`, source id, quarantine id).
    /// If the selection moves to a different audit row while the same operation stays selected, keeping
    /// the previous focused values would authorize the WRONG run. Operator-typed fields are theirs and
    /// are never clobbered by a selection change.
    public func reseedFocused(_ values: [String: String], selection: [String: String]) -> [String: String] {
        var out = values
        for f in fields {
            guard case .focused(let key) = f.kind else { continue }
            if let v = selection[key] {
                out[f.name] = v
            } else {
                // The new selection carries no value for this focused key — clear rather than retain a
                // stale one from the previously-selected object.
                out.removeValue(forKey: f.name)
            }
        }
        return out
    }

    /// Assemble the router inputs from the merged editable values: focused fields route into the
    /// `FocusContext`, operator fields into the `entry` dict.
    public func inputs(values: [String: String]) -> (FocusContext, [String: String]) {
        var focus: [String: String] = [:]
        var entry: [String: String] = [:]
        for f in fields {
            guard let v = values[f.name], !v.isEmpty else { continue }
            switch f.kind {
            case .focused(let key): focus[key] = v
            case .operatorText, .operatorToggle: entry[f.name] = v
            }
        }
        return (FocusContext(fields: focus), entry)
    }
}

/// Enumerates `authorizableOps`, builds operand controls from the op's `OperationDescriptor` (focused
/// operands pre-filled from the current selection, operator fields as inputs), and calls `PrivilegedFlow`
/// via `AppModel.beginAction`. Renders every flow state from the mirrored `flowState`, and presents the
/// challenge-display modal when the flow reaches Display.
public struct ActionsView: View {
    @Bindable var model: AppModel
    @State private var selectedOp: String?
    @State private var values: [String: String] = [:]

    public init(model: AppModel) { self.model = model }

    private var form: ActionOperandForm? {
        guard let op = selectedOp, let descriptor = model.operationDescriptor(for: op) else { return nil }
        return ActionOperandForm(descriptor: descriptor)
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 16) {
            List(model.authorizableOps, id: \.self, selection: $selectedOp) { op in
                Text(op).accessibilityLabel("Privileged operation \(op)")
            }
            .frame(width: 240)
            .accessibilityLabel("Authorizable operations")
            .onChange(of: selectedOp) { _, _ in
                values = form?.seededValues(selection: model.selectedFocus) ?? [:]
            }
            // A changed SELECTION with the same operation still selected must refresh the focused
            // operands — otherwise the form keeps the previous object's runId and Begin would authorize
            // the wrong run. Operator-entered fields survive.
            .onChange(of: model.selectedFocus) { _, newFocus in
                guard let form else { return }
                values = form.reseedFocused(values, selection: newFocus)
            }

            VStack(alignment: .leading, spacing: 12) {
                if let op = selectedOp, let form {
                    Text(op).font(.title3).bold().accessibilityAddTraits(.isHeader)
                    ForEach(form.fields) { field in
                        operandControl(field)
                    }
                    Button("Begin") {
                        let (focus, entry) = form.inputs(values: values)
                        Task { await model.beginAction(op: op, focus: focus, entry: entry) }
                    }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityLabel("Begin \(op)")
                    Text("Flow: \(model.flowStateLabel(model.flowState))")
                        .font(.caption).foregroundStyle(.secondary)
                    if case .failed(let reason) = model.flowState {
                        Text(ControlSafeText.render(reason)).foregroundStyle(.red)
                    }
                } else if selectedOp != nil {
                    Text("This operation is not supported by the current Atlas build.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Select an operation").foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding()
        }
        .sheet(isPresented: challengePresented) {
            if let challenge = model.currentChallenge {
                ChallengeDisplayView(
                    challenge: challenge,
                    onConfirm: { Task { await model.confirmChallenge() } },
                    onCancel: { Task { await model.cancelFlow() } })
            }
        }
        .accessibilityLabel("Actions")
    }

    @ViewBuilder private func operandControl(_ field: ActionOperandForm.Field) -> some View {
        let binding = Binding<String>(
            get: { values[field.name] ?? "" },
            set: { values[field.name] = $0 })
        switch field.kind {
        case .operatorToggle:
            Toggle(field.label, isOn: Binding(
                get: { ActionOperandForm.isTruthy(values[field.name]) },
                set: { values[field.name] = $0 ? "true" : "" }))
                .accessibilityLabel("\(field.label)\(field.required ? " (required)" : "")")
        case .focused, .operatorText:
            TextField(field.label, text: binding)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("\(field.label)\(field.required ? " (required)" : "")")
        }
    }

    private var challengePresented: Binding<Bool> {
        Binding(get: { model.currentChallenge != nil }, set: { _ in })
    }
}

extension ActionOperandForm {
    /// The same truthy set the router accepts for a boolean switch.
    static func isTruthy(_ raw: String?) -> Bool {
        guard let raw else { return false }
        return ["true", "1", "yes", "on"].contains(raw.lowercased())
    }
}

// MARK: - Query surface

/// The query text + explicit run action → `EgressAction.query` via the settings-selected key source.
/// Never polled — only the Run button invokes it. Its `model_call` event lands in the feed.
public struct QueryView: View {
    @Bindable var model: AppModel
    @State private var text: String = ""
    public init(model: AppModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Query").font(.title2).bold().accessibilityAddTraits(.isHeader)
            HStack {
                TextField("Ask the vault…", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Query text")
                Button("Run") { Task { await model.runQuery(text) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(text.isEmpty)
                    .accessibilityLabel("Run query")
            }
            if let err = model.lastQueryError {
                Text(ControlSafeText.render(err)).foregroundStyle(.red)
                    .accessibilityLabel("Query failed")
            } else if let result = model.lastQueryResult {
                ScrollView {
                    Text(ControlSafeText.plain(String(decoding: result.data, as: UTF8.self)))
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            Spacer()
        }
        .padding()
        .accessibilityLabel("Query")
    }
}

// MARK: - Settings surface

/// Edits `Settings`; Apply drives `AppModel.applySettings` (probe-before-persist, atomic-or-rolled-back).
public struct SettingsView: View {
    @Bindable var model: AppModel
    @State private var draft: ConsoleCore.Settings

    public init(model: AppModel, initial: ConsoleCore.Settings? = nil) {
        self.model = model
        // Start from the current/loaded settings, NOT `.defaults` — otherwise the running Settings tab
        // shows blanks and an Apply would erase existing overrides.
        self._draft = State(initialValue: initial ?? model.currentSettingsSnapshot)
    }

    public var body: some View {
        Form {
            Section("Paths") {
                TextField("Atlas root", text: optionalBinding(\.atlasRoot))
                    .accessibilityLabel("Atlas checkout root")
                TextField("brain override", text: optionalBinding(\.brainPathOverride))
                TextField("signer override", text: optionalBinding(\.signerPathOverride))
            }
            Section("Watch") {
                TextField("poll ms", text: intBinding(\.pollMs))
                TextField("heartbeat seconds", text: intBinding(\.heartbeatSeconds))
            }
            Section("Egress key source") {
                Picker("Source", selection: $draft.egressCapabilityKeySource) {
                    ForEach(EgressKeySource.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
            }
            Section("Resume") {
                Picker("Mode", selection: $draft.resumeMode) {
                    Text("resume").tag(ResumeMode.resume)
                    Text("replayAll").tag(ResumeMode.replayAll)
                    Text("liveOnly").tag(ResumeMode.liveOnly)
                }.pickerStyle(.segmented)
            }
            if let err = model.settingsError {
                Text(ControlSafeText.render(err)).foregroundStyle(.red)
            }
            Button("Apply") { Task { await model.applySettings(draft) } }
                .keyboardShortcut(.defaultAction)
                .accessibilityLabel("Apply settings")
        }
        .padding()
        .accessibilityLabel("Settings")
    }

    private func optionalBinding(_ kp: WritableKeyPath<ConsoleCore.Settings, String?>) -> Binding<String> {
        Binding(get: { draft[keyPath: kp] ?? "" },
                set: { draft[keyPath: kp] = $0.isEmpty ? nil : $0 })
    }
    private func intBinding(_ kp: WritableKeyPath<ConsoleCore.Settings, Int?>) -> Binding<String> {
        Binding(get: { draft[keyPath: kp].map(String.init) ?? "" },
                set: { draft[keyPath: kp] = Int($0) })
    }
}
