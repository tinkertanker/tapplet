import SwiftUI

struct GuidedMakeView: View {
    let store: TappletStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var creationError: TappletErrorPresentation?
    @FocusState private var responseIsFocused: Bool

    private var question: BriefQuestion {
        BriefQuestion.all[store.guidedMakeQuestionIndex]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeader(
                    title: "Plan your classroom applet",
                    subtitle: "Answer six quick questions. You can review and change every answer before Tapplet makes your applet.",
                    sticker: .handraise
                )

                Group {
                    if store.guidedMakeShowsSummary {
                        summaryCard
                    } else {
                        questionCard
                    }
                }
                .frame(maxWidth: 760)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(32)
        }
        .accessibilityIdentifier("make-screen")
    }

    private var questionCard: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Question \(store.guidedMakeQuestionIndex + 1) of \(BriefQuestion.all.count)")
                        .font(TappletTheme.Typography.eyebrow)
                        .foregroundStyle(TappletTheme.mutedInk)
                    Spacer()
                    if question.isOptional {
                        Text("Optional")
                            .font(.caption)
                            .foregroundStyle(TappletTheme.mutedInk)
                    }
                }
                ProgressView(
                    value: Double(store.guidedMakeQuestionIndex + 1),
                    total: Double(BriefQuestion.all.count)
                )
                    .tint(TappletTheme.accent)
            }

            VStack(alignment: .leading, spacing: 9) {
                Text(question.prompt)
                    .font(TappletTheme.Typography.question)
                    .foregroundStyle(TappletTheme.ink)
                Text(question.supportingText)
                    .font(.body)
                    .foregroundStyle(TappletTheme.mutedInk)
            }

            TextEditor(
                text: Binding(
                    get: { store.guidedMakeResponse },
                    set: { store.guidedMakeResponse = $0 }
                )
            )
                .font(.body)
                .frame(minHeight: 112)
                .padding(12)
                .scrollContentBackground(.hidden)
                .background(TappletTheme.canvas, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(alignment: .topLeading) {
                    if store.guidedMakeResponse.isEmpty {
                        Text(question.placeholder)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 17)
                            .padding(.vertical, 20)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .focused($responseIsFocused)
                .accessibilityLabel(question.prompt)
                .accessibilityHint(question.supportingText)
                .accessibilityIdentifier("guided-answer")

            VStack(alignment: .leading, spacing: 9) {
                Text("Or start here")
                    .font(TappletTheme.Typography.eyebrow)
                    .foregroundStyle(TappletTheme.mutedInk)
                FlowLayout(spacing: 8) {
                    ForEach(question.suggestions, id: \.self) { suggestion in
                        Button(suggestion) {
                            addSuggestion(suggestion)
                        }
                        .buttonStyle(TappletSecondaryButtonStyle(borderShape: .capsule))
                        .controlSize(.large)
                        .font(.subheadline)
                        .accessibilityHint(
                            cleanResponse.isEmpty
                                ? "Uses this suggestion as your answer."
                                : "Adds this idea after the answer you have already written."
                        )
                    }
                }
            }

            Divider()

            HStack {
                Button("Back") { moveBack() }
                    .buttonStyle(TappletSecondaryButtonStyle())
                    .controlSize(.large)
                    .disabled(store.guidedMakeQuestionIndex == 0)
                Spacer()
                if question.isOptional && cleanResponse.isEmpty {
                    Button("Skip") { moveForward() }
                        .buttonStyle(TappletSecondaryButtonStyle())
                        .controlSize(.large)
                }
                Button(store.guidedMakeQuestionIndex == BriefQuestion.all.count - 1 ? "Review answers" : "Continue") {
                    moveForward()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!question.isOptional && cleanResponse.isEmpty)
                .accessibilityIdentifier("guided-continue")
            }
        }
        .padding(28)
        .tappletCard()
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text(store.isCreatingGuidedDraft ? "Making your applet" : "Check your answers")
                    .font(TappletTheme.Typography.question)
                Text(
                    store.isCreatingGuidedDraft
                        ? "Tapplet is working from the answers below."
                        : "Tap any answer to change it, then make your applet. You can keep refining it afterwards."
                )
                    .foregroundStyle(TappletTheme.mutedInk)
            }

            if store.isCreatingGuidedDraft {
                generationStatus
            }

            VStack(spacing: 0) {
                summaryRow(label: "Students", value: store.guidedMakeDraft.learnerContext, questionIndex: 0)
                Divider()
                summaryRow(label: "Learning goal", value: store.guidedMakeDraft.learningObjective, questionIndex: 1)
                Divider()
                summaryRow(label: "Students will", value: store.guidedMakeDraft.studentAction, questionIndex: 2)
                Divider()
                summaryRow(
                    label: "Must include",
                    value: store.guidedMakeDraft.sourceContent.isEmpty
                        ? "No required source content"
                        : store.guidedMakeDraft.sourceContent,
                    questionIndex: 3
                )
                Divider()
                summaryRow(label: "How it responds", value: store.guidedMakeDraft.feedback, questionIndex: 4)
                Divider()
                summaryRow(label: "In the lesson", value: store.guidedMakeDraft.classroomFit, questionIndex: 5)
            }
            .background(TappletTheme.canvas, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Text("The applet will not collect responses, identify students or call external services.")
                .font(.footnote)
                .foregroundStyle(TappletTheme.mutedInk)

            if let creationError {
                VStack(alignment: .leading, spacing: 4) {
                    Label(creationError.title, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.semibold))
                    Text(creationError.message)
                        .font(.callout)
                }
                    .foregroundStyle(TappletTheme.danger)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(TappletTheme.dangerSoft, in: RoundedRectangle(cornerRadius: 12))
            }

            HStack {
                Button("Change answers") {
                    editAnswer(at: 0)
                }
                .buttonStyle(TappletSecondaryButtonStyle())
                .controlSize(.large)
                .disabled(store.isCreatingGuidedDraft)
                Spacer()
                Button {
                    createDraft()
                } label: {
                    if store.isCreatingGuidedDraft {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Making your applet…")
                        }
                    } else {
                        Text("Make my applet")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(store.isCreatingGuidedDraft)
                .accessibilityIdentifier("approve-brief")
            }
        }
        .padding(28)
        .tappletCard()
    }

    private var generationStatus: some View {
        HStack(alignment: .top, spacing: 14) {
            ProgressView()
                .controlSize(.large)
                .tint(TappletTheme.accent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text("This usually takes one to two minutes.")
                    .font(.body.weight(.semibold))
                Text("Your answers are still here and will be used to make your applet. There is nothing else you need to do right now.")
                    .font(.callout)
                    .foregroundStyle(TappletTheme.mutedInk)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TappletTheme.canvas, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TappletTheme.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Making your applet. This usually takes one to two minutes. Your answers are still here and will be used to make your applet.")
    }

    private func summaryRow(label: String, value: String, questionIndex: Int) -> some View {
        Button {
            editAnswer(at: questionIndex)
        } label: {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TappletTheme.mutedInk)
                    Text(value)
                        .font(.body)
                        .foregroundStyle(TappletTheme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Edit answer")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TappletTheme.accent)
                }
            } else {
                HStack(alignment: .top, spacing: 20) {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TappletTheme.mutedInk)
                        .frame(width: 110, alignment: .leading)
                    Text(value)
                        .font(.body)
                        .foregroundStyle(TappletTheme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TappletTheme.mutedInk)
                        .padding(.top, 4)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .padding(14)
        .disabled(store.isCreatingGuidedDraft)
        .accessibilityLabel("Edit \(label) answer")
        .accessibilityValue(value)
        .accessibilityHint("Returns to question \(questionIndex + 1).")
        .accessibilityIdentifier("edit-brief-answer-\(questionIndex)")
    }

    private var cleanResponse: String {
        store.guidedMakeResponse.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func moveForward() {
        guard !store.isCreatingGuidedDraft else { return }
        store.guidedMakeDraft.setAnswer(cleanResponse, at: store.guidedMakeQuestionIndex)
        if store.guidedMakeQuestionIndex == BriefQuestion.all.count - 1 {
            store.guidedMakeShowsSummary = true
            responseIsFocused = false
        } else {
            store.guidedMakeQuestionIndex += 1
            store.guidedMakeResponse = store.guidedMakeDraft.answer(
                at: store.guidedMakeQuestionIndex
            )
            responseIsFocused = true
        }
    }

    private func moveBack() {
        guard !store.isCreatingGuidedDraft else { return }
        guard store.guidedMakeQuestionIndex > 0 else { return }
        store.guidedMakeDraft.setAnswer(cleanResponse, at: store.guidedMakeQuestionIndex)
        store.guidedMakeQuestionIndex -= 1
        store.guidedMakeResponse = store.guidedMakeDraft.answer(
            at: store.guidedMakeQuestionIndex
        )
        responseIsFocused = true
    }

    private func addSuggestion(_ suggestion: String) {
        guard !store.isCreatingGuidedDraft else { return }
        guard !cleanResponse.isEmpty else {
            store.guidedMakeResponse = suggestion
            responseIsFocused = true
            return
        }
        guard !store.guidedMakeResponse.contains(suggestion) else { return }
        store.guidedMakeResponse += store.guidedMakeResponse.hasSuffix("\n") ? suggestion : "\n\(suggestion)"
        responseIsFocused = true
    }

    private func editAnswer(at questionIndex: Int) {
        guard !store.isCreatingGuidedDraft else { return }
        creationError = nil
        store.guidedMakeShowsSummary = false
        store.guidedMakeQuestionIndex = questionIndex
        store.guidedMakeResponse = store.guidedMakeDraft.answer(at: questionIndex)
        responseIsFocused = true
    }

    private func createDraft() {
        creationError = nil
        Task {
            do {
                _ = try await store.createApprovedBrief(store.guidedMakeDraft)
                store.resetGuidedMake()
            } catch {
                creationError = store.present(error, during: .generation)
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, placement) in result.placements.enumerated() {
            subviews[index].place(
                at: CGPoint(
                    x: bounds.minX + placement.point.x,
                    y: bounds.minY + placement.point.y
                ),
                proposal: placement.proposal
            )
        }
    }

    private func layout(
        proposal: ProposedViewSize,
        subviews: Subviews
    ) -> (size: CGSize, placements: [(point: CGPoint, proposal: ProposedViewSize)]) {
        let maxWidth = proposal.width ?? .infinity
        var placements: [(point: CGPoint, proposal: ProposedViewSize)] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let idealSize = subview.sizeThatFits(.unspecified)
            let subviewProposal = idealSize.width > maxWidth
                ? ProposedViewSize(width: maxWidth, height: nil)
                : ProposedViewSize.unspecified
            let size = subview.sizeThatFits(subviewProposal)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            placements.append((CGPoint(x: x, y: y), subviewProposal))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }

        return (
            CGSize(width: maxWidth.isFinite ? maxWidth : x, height: y + rowHeight),
            placements
        )
    }
}
