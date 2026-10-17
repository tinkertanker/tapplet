import SwiftUI

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
