// What a sale actually did, in terms a player can be told.
//
// All three selling screens used to decide whether a sale had worked by
// watching the money. That is right until the rescue loan is outstanding, and
// then it is exactly wrong: repayment comes off the top, so a sale worth less
// than the debt empties the barn, pays down the loan, and leaves the money
// untouched. The shop read that as a refusal and said so — a red toast, the
// refused sound, and the player's crops gone anyway. The market and the coop
// said nothing at all, which is only better because it is quieter.
//
// A sale is something that happened if the farm changed, and what to say about
// it depends on where the money went.
import { t } from '../core/i18n.js'
import { money } from './kit.js'

/** The farm's side of a sale, before and after, as the player would judge it. */
export const takings = (state) => ({ money: state.money, debt: state.debt ?? 0 })

/**
 * Compare two takings and say what happened.
 *
 * `kept` is what reached the player's hand, `repaid` what went to the loan, and
 * `happened` is whether the sale went through at all — which is the question the
 * screens were getting wrong.
 */
export function outcome(before, after) {
  const kept = after.money - before.money
  const repaid = before.debt - after.debt
  return { kept, repaid, happened: kept > 0 || repaid > 0 }
}

/** The line to show for it, or null when nothing happened. */
export function saidAs(result) {
  if (!result.happened) return null
  if (result.kept > 0 && result.repaid > 0) return t('sale.keptAndRepaid', money(result.kept), money(result.repaid))
  if (result.kept > 0) return `+$${money(result.kept)}`
  return t('sale.loanTook', money(result.repaid))
}
