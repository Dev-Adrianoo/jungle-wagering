import { BetPolicy } from './bet-policy';
import { LossPolicy } from './loss-policy';
import { RefundPolicy } from './refund-policy';
import { RollbackPolicy } from './rollback-policy';
import type { WagerPolicy } from './wager-policy';
import { WinPolicy } from './win-policy';

export function defaultPolicies(): WagerPolicy[] {
  return [
    new BetPolicy(),
    new WinPolicy(),
    new LossPolicy(),
    new RefundPolicy(),
    new RollbackPolicy(),
  ];
}
