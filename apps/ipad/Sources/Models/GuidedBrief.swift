import Foundation

enum ActivityFormat: String, CaseIterable, Codable, Hashable, Sendable {
    case game
    case quiz
    case simulation
    case practice

    var title: String {
        switch self {
        case .game: "Game"
        case .quiz: "Quiz"
        case .simulation: "Simulation"
        case .practice: "Practice"
        }
    }
}

struct GuidedBriefDraft: Equatable, Sendable {
    var learnerContext = ""
    var learningObjective = ""
    var studentAction = ""
    var sourceContent = ""
    var feedback = ""
    var classroomFit = ""
    var format: ActivityFormat?

    var answers: [String] {
        [learnerContext, learningObjective, studentAction, sourceContent, feedback, classroomFit]
    }

    mutating func setAnswer(_ answer: String, at index: Int) {
        switch index {
        case 0: learnerContext = answer
        case 1: learningObjective = answer
        case 2: studentAction = answer
        case 3: sourceContent = answer
        case 4: feedback = answer
        case 5: classroomFit = answer
        default: break
        }
    }

    func answer(at index: Int) -> String {
        answers[index]
    }
}

struct GuidedGenerationBrief: Codable, Equatable, Sendable {
    let learnerContext: String
    let learningObjective: String
    let studentAction: String
    let sourceContent: String?
    let feedback: String
    let classroomFit: String
    let format: String?
}

struct GuidedGenerationRequest: Codable, Equatable, Sendable {
    let creationBrief: String
    let brief: GuidedGenerationBrief
    let preferredExampleRevisionId: String?
}

struct BriefQuestion: Identifiable, Sendable {
    let id: Int
    let prompt: String
    let supportingText: String
    let placeholder: String
    let suggestions: [String]
    let isOptional: Bool

    static let all: [BriefQuestion] = [
        BriefQuestion(
            id: 0,
            prompt: "Who are you teaching?",
            supportingText: "A level and subject is enough. You can add language or support needs too.",
            placeholder: "For example, Secondary 3 Physics",
            suggestions: ["Primary 5 Science", "Secondary 2 Mathematics", "Secondary 3 Humanities"],
            isOptional: false
        ),
        BriefQuestion(
            id: 1,
            prompt: "What should they understand or be able to do?",
            supportingText: "Start with the learning, not the screen you want to build.",
            placeholder: "Explain a key idea in their own words",
            suggestions: ["Recall key ideas", "Explain a relationship", "Practise a procedure", "Build speed and accuracy"],
            isOptional: false
        ),
        BriefQuestion(
            id: 2,
            prompt: "What should students do on screen?",
            supportingText: "Name the kind of activity if you know it — a game, quiz or simulation — and the one thing students do in it.",
            placeholder: "Choose, predict, then compare what happens",
            suggestions: [
                "Beat a 60-second countdown",
                "Wrong answers cost a life",
                "Keep a streak going",
                "Sort items into bins",
                "Explore a changing graph"
            ],
            isOptional: false
        ),
        BriefQuestion(
            id: 3,
            prompt: "What must the tapplet include?",
            supportingText: "Add examples, vocabulary, values or instructions. Avoid student names and personal information.",
            placeholder: "Use the terms and examples from this lesson",
            suggestions: ["I will add this later", "Use familiar local examples", "Keep the language concise"],
            isOptional: true
        ),
        BriefQuestion(
            id: 4,
            prompt: "How should the tapplet respond?",
            supportingText: "Student tapplets work locally and do not collect responses.",
            placeholder: "Reveal a hint, then explain the answer",
            suggestions: ["Immediate explanation", "Hints before answers", "Explain every wrong answer", "No marking — exploration only"],
            isOptional: false
        ),
        BriefQuestion(
            id: 5,
            prompt: "How will this fit into the lesson?",
            supportingText: "A rough duration and mode helps Tapplet Studio keep the activity focused.",
            placeholder: "Eight minutes, students work in pairs on phones",
            suggestions: ["5 minutes individually", "10 minutes in pairs", "Whole-class discussion"],
            isOptional: false
        )
    ]
}

struct StarterPlan: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let summary: String
    let form: ActivityFormat
    let exampleID: String
    let draft: GuidedBriefDraft

    var exampleRevisionID: String { "\(exampleID)-seed" }

    static func matching(exampleID: String) -> StarterPlan? {
        all.first { $0.exampleID == exampleID }
    }

    static func matching(exampleRevisionID: String) -> StarterPlan? {
        all.first { $0.exampleRevisionID == exampleRevisionID }
    }

    static let all: [StarterPlan] = [
        StarterPlan(
            id: "times-tables-lightning",
            title: "Times-tables lightning",
            summary: "A 60-second race through the 6 to 9 times tables, with missed facts at the end.",
            form: .game,
            exampleID: "times-tables-lightning",
            draft: GuidedBriefDraft(
                learnerContext: "Primary 5 Mathematics",
                learningObjective: "Recall multiplication facts from the 6, 7, 8 and 9 times tables fluently.",
                studentAction: "Beat a 60-second countdown. Keep a streak going. Missed facts come back at the end.",
                sourceContent: "Use the 6, 7, 8 and 9 times tables. Four answer buttons each round.",
                feedback: "Explain every wrong answer with the related fact family.",
                classroomFit: "5 minutes individually",
                format: .game
            )
        ),
        StarterPlan(
            id: "spell-it-before-the-sun-sets",
            title: "Spell it before the sun sets",
            summary: "Guess letters. Each miss adds a sun ray and explains a spelling pattern.",
            form: .game,
            exampleID: "spell-it-before-the-sun-sets",
            draft: GuidedBriefDraft(
                learnerContext: "Primary 5 English",
                learningObjective: "Spell high-frequency words with silent letters and common letter patterns.",
                studentAction: "Wrong answers cost a life. Guess letters until the word is complete or the sun fills.",
                sourceContent: "Start with island, enough, science, receipt, friend and rhythm. Swap in this week's spelling list.",
                feedback: "Explain every wrong answer with the spelling pattern, then reveal the word if the sun fills.",
                classroomFit: "5 minutes individually",
                format: .game
            )
        ),
        StarterPlan(
            id: "line-golf",
            title: "Line golf",
            summary: "Fit y = mx + c through flags in as few strokes as possible.",
            form: .game,
            exampleID: "line-golf",
            draft: GuidedBriefDraft(
                learnerContext: "Secondary 2 Mathematics",
                learningObjective: "Choose gradient and intercept so a straight line passes through given points.",
                studentAction: "Explore a changing graph. Each check is a stroke. Beat par.",
                sourceContent: "Three holes with flag coordinates shown on the graph.",
                feedback: "Say whether the line is too high or too low for a missed flag, and whether to change m or c.",
                classroomFit: "10 minutes in pairs",
                format: .game
            )
        ),
        StarterPlan(
            id: "conductor-or-insulator",
            title: "Conductor or insulator?",
            summary: "Sort objects into two bins. A wrong bin costs a life and says why.",
            form: .game,
            exampleID: "conductor-or-insulator",
            draft: GuidedBriefDraft(
                learnerContext: "Primary 5 Science",
                learningObjective: "Classify materials as electrical conductors or insulators and explain the difference.",
                studentAction: "Sort items into bins. Wrong answers cost a life. Beat a 60-second countdown.",
                sourceContent: "Copper coin, aluminium foil, iron nail, pencil graphite, rubber band, plastic ruler, wooden chopsticks, glass bottle.",
                feedback: "Explain every wrong answer. A conductor lets electric current pass through; an insulator does not.",
                classroomFit: "5 minutes individually",
                format: .game
            )
        ),
        StarterPlan(
            id: "catchment-under-pressure",
            title: "Rain, paved ground and drainage",
            summary: "Predict a flood, then change rainfall, paving and drains on a live model.",
            form: .simulation,
            exampleID: "catchment-under-pressure",
            draft: GuidedBriefDraft(
                learnerContext: "Secondary 2 Geography",
                learningObjective: "Explain how rainfall intensity, impermeable cover and drainage capacity affect surface-water accumulation.",
                studentAction: "Explore a changing graph. Predict first, then move the sliders.",
                sourceContent: "Use a local catchment with paved ground and storm drains.",
                feedback: "Compare the prediction with the model and explain which factor mattered most.",
                classroomFit: "10 minutes in pairs",
                format: .simulation
            )
        ),
        StarterPlan(
            id: "mean-and-median",
            title: "Mean and median",
            summary: "Drag one score and watch which average moves.",
            form: .simulation,
            exampleID: "mean-and-median",
            draft: GuidedBriefDraft(
                learnerContext: "Primary 6 Mathematics",
                learningObjective: "Compare how an extreme score affects the mean and median and explain the difference.",
                studentAction: "Explore a changing graph. Drag one score, then explain which average moved.",
                sourceContent: "Seven whole-number scores on a dot plot.",
                feedback: "Explain every wrong answer. The mean uses every score; the median is the middle score.",
                classroomFit: "8 minutes individually",
                format: .simulation
            )
        ),
        StarterPlan(
            id: "cool-box-fair-test-lab",
            title: "Which lining keeps water cool?",
            summary: "Plan a fair test: classify variables, spot a confound, put the method in order.",
            form: .practice,
            exampleID: "cool-box-fair-test-lab",
            draft: GuidedBriefDraft(
                learnerContext: "Primary 5 Science",
                learningObjective: "Identify what is changed, measured and kept the same, then improve a method to test one factor fairly.",
                studentAction: "Sort items into bins, then put the method steps in order.",
                sourceContent: "Bottle linings on a windowsill versus a storeroom. Keep the language of changed, measured and kept the same.",
                feedback: "Hints before answers, then explain why a step is unfair.",
                classroomFit: "10 minutes in pairs",
                format: .practice
            )
        ),
        StarterPlan(
            id: "town-council-budget",
            title: "Share the town budget",
            summary: "Split a fixed budget and see who is hit by each mix.",
            form: .simulation,
            exampleID: "town-council-budget",
            draft: GuidedBriefDraft(
                learnerContext: "Secondary 3 Humanities",
                learningObjective: "Explain how allocating a fixed public budget creates trade-offs between service outcomes.",
                studentAction: "Explore a changing graph. Split $100,000 and name who is hit hardest.",
                sourceContent: "Cleanliness, clinic, youth programmes and lift repairs in a town council.",
                feedback: "No marking — exploration only. Ask students to justify the mix.",
                classroomFit: "10 minutes in pairs",
                format: .simulation
            )
        )
    ]
}

struct RefineSuggestion: Identifiable, Sendable {
    let id: String
    let title: String

    static let all: [RefineSuggestion] = [
        RefineSuggestion(id: "timer", title: "Add a 60-second timer"),
        RefineSuggestion(id: "lives", title: "Give three lives"),
        RefineSuggestion(id: "streak", title: "Keep score with a streak"),
        RefineSuggestion(id: "explain", title: "Explain wrong answers"),
        RefineSuggestion(id: "harder", title: "Add a harder round"),
        RefineSuggestion(id: "bigger", title: "Make the text and buttons bigger")
    ]
}
