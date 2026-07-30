from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AnomalyRuleDefinition:
    rule_id: str
    version: int
    type: str
    minimum_sample_size: int
    severity: str
    blocking_scope: str
    enabled: bool = True


ANOMALY_RULES = {
    "readiness_deterministic": AnomalyRuleDefinition(
        rule_id="readiness_deterministic",
        version=1,
        type="deterministic",
        minimum_sample_size=1,
        severity="blocker",
        blocking_scope="export",
    ),
    "numeric_robust_outlier": AnomalyRuleDefinition(
        rule_id="numeric_robust_outlier",
        version=1,
        type="statistical",
        minimum_sample_size=20,
        severity="warning",
        blocking_scope="none",
    ),
}


def enabled_rule(rule_id: str) -> AnomalyRuleDefinition:
    rule = ANOMALY_RULES.get(rule_id)
    if rule is None or not rule.enabled:
        raise KeyError(rule_id)
    return rule
