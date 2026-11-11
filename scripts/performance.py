#!/usr/bin/env python3
"""Summarize local CLI recordings and compare explicitly matched task attempts.

This tool never contacts a device or a model. It reads calls.ndjson, not raw UI
output. Phase annotations and matching metadata are supplied by the evaluator.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
import math
from pathlib import Path
import re
import sys


PLAN_COMMANDS = {"run", "execute"}
PHASES = {"screenshot", "manual_wait", "request_build", "analysis", "scheduling", "model", "other"}
MATCH_FIELDS = ("taskId", "taskRevision", "initialStateId", "expectedOutcomeId",
                "verificationSpecId", "actionSequence", "requiredScreenshots", "environmentId", "modelConfigId",
                "executionMode")
EXECUTION_MODES = {"cold_setup", "warm_continue"}
PLAN_BOUNDARIES = {"known_sequence", "unknown_page", "human_decision", "required_screenshot",
                   "goal_reached", "budget_limit", "recovery", "other"}
EVENT_SOURCES = {"host_trace", "harness", "manual"}
MILESTONES = ("task_start", "goal_verified", "cleanup_complete", "response_complete")


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("A timezone-aware ISO timestamp is required.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Invalid ISO timestamp.") from exc
    if result.tzinfo is None:
        raise ValueError("A timezone-aware ISO timestamp is required.")
    return result.timestamp() * 1000


def rounded(value):
    return round(value, 3) if value is not None else None


def object_value(value, name):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(name + " must be an object.")
    return value


def matching_metadata(manifest):
    result = {key: manifest[key] for key in (*MATCH_FIELDS, "coreId", "strategyId", "completedScreenshots") if key in manifest}
    if isinstance(manifest.get("result"), dict):
        result["result"] = {key: manifest["result"][key] for key in ("status", "verifiedOutcomeId", "verificationMethod")
                            if key in manifest["result"]}
    return result


def interval(event):
    start, end = timestamp(event.get("startedAt")), timestamp(event.get("endedAt"))
    if end < start:
        raise ValueError("An interval ends before it starts.")
    return start, end


def intersection(first, second):
    return max(0, min(first[1], second[1]) - max(first[0], second[0]))


def opaque_id(value, field):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        raise ValueError(field + " must be an opaque ASCII ID of 1-128 characters.")
    return value


def union_duration(intervals):
    total, cursor = 0, None
    for start, end in sorted(intervals):
        total += max(0, end - max(start, cursor if cursor is not None else start))
        cursor = max(cursor if cursor is not None else end, end)
    return total


def external_context(rows, timed, events, clock_offsets, clock_sources, clock_tolerance):
    """Host IDs and milestones are supplied evidence, never inferred CLI counts."""
    row_ids, modes, boundaries = {}, set(), []
    for index, row in enumerate(rows):
        if row.get("hostCallId") is not None:
            row_ids[index] = opaque_id(row["hostCallId"], "hostCallId")
        if row.get("executionMode") is not None:
            if row["executionMode"] not in EXECUTION_MODES:
                raise ValueError("Unknown recorded executionMode.")
            modes.add(row["executionMode"])
        reason = row.get("declaredPlanBoundary")
        if reason is not None and (reason not in PLAN_BOUNDARIES or row.get("command") not in PLAN_COMMANDS):
            raise ValueError("A declared plan boundary needs a run/execute command and a known reason.")
        if row.get("command") in PLAN_COMMANDS:
            boundaries.append({"callId": row.get("callId"), "hostCallId": row_ids.get(index),
                               "reason": reason, "runStatus": row.get("runStatus"),
                               "source": "caller_declaration" if reason is not None else None})

    reference = (clock_offsets[0] if clock_offsets and len(clock_sources) == 1
                 and max(clock_offsets) - min(clock_offsets) <= clock_tolerance else None)
    expected_source = next(iter(clock_sources)) if len(clock_sources) == 1 else None

    def verified_point(wall, monotonic, event_source):
        return (reference is not None and type(monotonic) is int and monotonic >= 0
                and event_source == expected_source
                and abs(wall - monotonic / 1e6 - reference) <= clock_tolerance)

    host_by_id, points, point_times, host_issues, milestone_issues = {}, {}, {}, [], []
    for event in events:
        kind = event.get("kind")
        if kind not in {"host_call", "milestone"}:
            continue
        if event.get("source") not in EVENT_SOURCES:
            raise ValueError("Host and milestone events require an explicit source.")
        if kind == "host_call":
            host_id = opaque_id(event.get("hostCallId"), "hostCallId")
            if host_id in host_by_id:
                raise ValueError("A host call ID must have exactly one recorded interval.")
            start, end = interval(event)
            boundary = event.get("boundaryKind")
            if boundary not in {None, "host_tool_call", "nested_tool_api"}:
                raise ValueError("Unknown host call boundaryKind.")
            outer_id = opaque_id(event["outerCallId"], "outerCallId") if event.get("outerCallId") is not None else None
            event_clock = event.get("clockSource", "legacy_unspecified")
            clock_verified = (verified_point(start, event.get("startedMonotonicNs"), event_clock)
                              and verified_point(end, event.get("endedMonotonicNs"), event_clock))
            host_by_id[host_id] = {"hostCallId": host_id, "startedAt": event["startedAt"],
                                   "endedAt": event["endedAt"], "source": event["source"],
                                   "boundaryKind": boundary, "outerCallId": outer_id,
                                   "wallMs": rounded(end-start), "clockVerified": clock_verified,
                                   "cliCalls": sum(value == host_id for value in row_ids.values()),
                                   "_bounds": (start, end)}
        else:
            name = event.get("name")
            if name not in MILESTONES or name in points:
                raise ValueError("Milestone names must be known and unique.")
            moment = timestamp(event.get("at"))
            if name == "goal_verified" and event.get("verificationMethod") not in {
                    "independent_readback", "independent_evidence_review"}:
                raise ValueError("goal_verified needs an independent verification method.")
            points[name] = {"at": event["at"], "source": event["source"],
                            "clockVerified": verified_point(moment, event.get("monotonicNs"),
                                                             event.get("clockSource", "legacy_unspecified"))}
            if name == "goal_verified":
                points[name]["verificationMethod"] = event["verificationMethod"]
                passed = event.get("passed")
                declared = event.get("status")
                if passed is not None and type(passed) is not bool:
                    raise ValueError("A milestone passed value must be boolean or null.")
                if declared is not None and declared not in {"passed", "failed", "unknown"}:
                    raise ValueError("Unknown goal verification status.")
                from_boolean = "passed" if passed is True else "failed" if passed is False else "unknown"
                verification_status = declared or from_boolean
                if "passed" in event and declared is not None and declared != from_boolean:
                    milestone_issues.append("conflicting_goal_verification_status")
                    verification_status = "unknown"
                points[name].update(verificationStatus=verification_status,
                                    passed=True if verification_status == "passed" else False if verification_status == "failed" else None,
                                    declaredPassed=passed, declaredStatus=declared)
                if verification_status != "passed":
                    milestone_issues.append("goal_not_verified")
            point_times[name] = moment

    ordered = [point_times[name] for name in MILESTONES if name in point_times]
    if any(later < earlier for earlier,later in zip(ordered,ordered[1:])):
        milestone_issues.append("milestone_order_invalid")

    covered, timed_covered = 0, 0
    for start, end, index in timed:
        host = host_by_id.get(row_ids.get(index))
        if host:
            covered += 1
            if host["_bounds"][0] <= start and end <= host["_bounds"][1]:
                timed_covered += 1
            else:
                host_issues.append("cli_outside_declared_host_bounds")
    known_ids = set(row_ids.values()) | set(host_by_id)
    durations, duration_clocks = {}, {}
    for name, metric in (("goal_verified", "toGoalVerifiedMs"), ("cleanup_complete", "toCleanupCompleteMs"),
                         ("response_complete", "toResponseCompleteMs")):
        measured = ("task_start" in point_times and name in point_times
                    and (name != "goal_verified" or points[name]["verificationStatus"] == "passed"))
        elapsed = point_times[name] - point_times["task_start"] if measured else None
        if elapsed is not None and elapsed < 0:
            milestone_issues.append("milestone_before_task_start")
            elapsed = None
        durations[metric] = rounded(elapsed)
        duration_clocks[metric] = ((points["task_start"]["clockVerified"] and points[name]["clockVerified"])
                                   if measured else None)
    full_bounds = None
    if "task_start" in point_times and "response_complete" in point_times:
        full_bounds = point_times["task_start"], point_times["response_complete"]
        if full_bounds[1] < full_bounds[0]:
            raise ValueError("response_complete cannot precede task_start.")
    host = {"recordedCount": len(host_by_id) if host_by_id else None,
            "identifiedCount": len(known_ids) if known_ids else None,
            "cliWithId": len(row_ids), "cliWithoutId": len(rows)-len(row_ids),
            "cliLinkedToRecordedHost": covered, "cliInsideDeclaredHostBounds": timed_covered,
            "wallSumMs": rounded(sum(item["wallMs"] for item in host_by_id.values())) if host_by_id else None,
            "busyMs": rounded(union_duration(item["_bounds"] for item in host_by_id.values())) if host_by_id else None,
            "spanMs": rounded(max(item["_bounds"][1] for item in host_by_id.values())
                              -min(item["_bounds"][0] for item in host_by_id.values())) if host_by_id else None,
            "timingSource": "external_event_intervals" if host_by_id else None,
            "clockVerified": all(item["clockVerified"] for item in host_by_id.values()) if host_by_id else None,
            "sourceCounts": dict(Counter(item["source"] for item in host_by_id.values())),
            "boundaryCounts": dict(Counter(item["boundaryKind"] or "unspecified" for item in host_by_id.values())),
            "outerToolCallCount": sum(item["boundaryKind"] == "host_tool_call" for item in host_by_id.values()) or None,
            "nestedToolApiCount": sum(item["boundaryKind"] == "nested_tool_api" for item in host_by_id.values()) or None,
            "modelToolRounds": None,
            "issues": sorted(set(host_issues)),
            "entries": [{key: value for key, value in item.items() if not key.startswith("_")}
                        for item in host_by_id.values()]}
    return {"host": host, "hostById": host_by_id, "rowIds": row_ids, "modes": sorted(modes),
            "planBoundaries": boundaries, "milestones": {name: points.get(name) for name in MILESTONES},
            "milestoneDurationsMs": durations, "milestoneDurationClockVerified": duration_clocks,
            "milestoneIssues": sorted(set(milestone_issues)), "fullTaskBounds": full_bounds,
            "fullTaskClockVerified": duration_clocks["toResponseCompleteMs"]}


def summarize(rows, *, manifest=None, events=None):
    """Keep duration sums separate from timeline intervals and nested stages."""
    if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) for row in rows):
        raise ValueError("At least one JSON call record is required.")
    manifest = manifest or {}
    if not isinstance(manifest, dict):
        raise ValueError("The manifest must be an object.")
    events = events or []
    if not isinstance(events, list) or not all(isinstance(event, dict) for event in events):
        raise ValueError("Events must be an array of interval objects.")
    clock_sources = {row.get("clockSource") or "legacy_unspecified" for row in rows}
    if any(source not in {"python.perf_counter_ns", "python.monotonic_ns", "legacy_unspecified"} for source in clock_sources):
        raise ValueError("Unknown recorded clockSource.")
    clock_tolerance = 10 if clock_sources == {"python.perf_counter_ns"} else 32
    issues, timed, durations, core_times, outside_times = [], [], [], [], []
    if len(clock_sources) != 1:
        issues.append("mixed_clock_sources")
    clock_offsets, monotonic_validated = [], 0
    stages, counts, capture_stages = Counter(), Counter(), Counter()
    commands, actions, statuses = Counter(), [], Counter()
    versions = set()
    instrumented_captures, capture_hdc_calls = 0, 0
    captures, action_count, capture_rows, action_rows = 0, 0, 0, 0
    for index, row in enumerate(rows):
        elapsed = number(row.get("elapsedMs"))
        if elapsed is not None:
            durations.append(elapsed)
        else:
            issues.append("missing_elapsed_time")
        try:
            call_interval = interval(row)
        except ValueError:
            issues.append("missing_or_invalid_start_end")
        else:
            timed.append((*call_interval, index))
            if elapsed is not None and abs(call_interval[1] - call_interval[0] - elapsed) > max(clock_tolerance, elapsed * .01):
                issues.append("wall_clock_duration_mismatch")
            mono_start, mono_end = row.get("startedMonotonicNs"), row.get("endedMonotonicNs")
            if type(mono_start) is int and type(mono_end) is int and 0 <= mono_start <= mono_end:
                monotonic_validated += 1
                clock_offsets.extend((call_interval[0] - mono_start / 1e6, call_interval[1] - mono_end / 1e6))
                if elapsed is not None and abs((mono_end - mono_start) / 1e6 - elapsed) > max(clock_tolerance, elapsed * .01):
                    issues.append("monotonic_duration_mismatch")
            else:
                issues.append("missing_or_invalid_monotonic_clock")
        profile = object_value(row.get("profile"), "profile")
        core_ms = number(profile.get("coreWallMs"))
        if core_ms is not None:
            core_times.append(core_ms)
            if elapsed is not None and core_ms <= elapsed:
                outside_times.append(elapsed - core_ms)
            else:
                issues.append("core_exceeds_process_wall")
        for name, value in object_value(profile.get("stagesMs"), "stagesMs").items():
            if number(value) is not None:
                stages[name] += value
        for name, value in object_value(profile.get("counts"), "counts").items():
            if number(value) is not None:
                counts[name] += value
        breakdown = object_value(profile.get("captureBreakdown"), "captureBreakdown")
        if breakdown:
            instrumented_captures += number(breakdown.get("instrumentedCaptures")) or 0
            capture_hdc_calls += number(breakdown.get("hdcCalls")) or 0
            for name, value in object_value(breakdown.get("stagesMs"), "capture stagesMs").items():
                if number(value) is not None:
                    capture_stages[name] += value
        if number(row.get("captureCount")) is not None:
            capture_rows += 1
            captures += row["captureCount"]
        if number(row.get("actionCount")) is not None:
            action_rows += 1
            action_count += row["actionCount"]
        row_actions = row.get("actionCommands", [])
        if not isinstance(row_actions, list) or not all(isinstance(value, str) for value in row_actions):
            raise ValueError("actionCommands must be an array of command names.")
        actions.extend(row_actions)
        commands[str(row.get("command") or "unknown")] += 1
        if row.get("runStatus"):
            statuses[str(row["runStatus"])] += 1
        if isinstance(row.get("packageVersion"), str):
            versions.add(row["packageVersion"])

    if clock_offsets and max(clock_offsets) - min(clock_offsets) > clock_tolerance:
        issues.append("clock_domain_or_offset_changed")

    context = external_context(rows, timed, events, clock_offsets, clock_sources, clock_tolerance)
    goal_milestone = context["milestones"]["goal_verified"]
    if (goal_milestone and goal_milestone["verificationStatus"] != "passed"
            and object_value(manifest.get("result"), "result").get("status") == "passed"):
        context["milestoneIssues"].append("goal_verification_conflicts_with_manifest")
    if len(context["modes"]) > 1:
        issues.append("mixed_execution_modes")
    if manifest.get("executionMode") is not None and any(mode != manifest["executionMode"] for mode in context["modes"]):
        issues.append("execution_mode_conflicts_with_manifest")
    task_events = [event for event in events if event.get("kind") == "task"]
    if len(task_events) > 1:
        raise ValueError("At most one explicit task interval is allowed.")
    phases = [event for event in events if event.get("kind") not in {"task", "host_call", "milestone"}]
    if any(event.get("kind") not in PHASES for event in phases):
        raise ValueError("Unknown phase kind.")
    gaps, timeline, phase_totals, annotated_totals = [], [], Counter(), Counter()
    phase_overlap, cli_busy, window_ms, screenshot_events = 0, None, None, 0
    window_kind = "task" if task_events or context["fullTaskBounds"] else "recorded_calls"
    window_basis = "task_interval" if task_events else "task_start_to_response_complete" if context["fullTaskBounds"] else "recorded_calls"
    clock_issues = {"mixed_clock_sources", "wall_clock_duration_mismatch", "monotonic_duration_mismatch",
                    "missing_or_invalid_monotonic_clock", "clock_domain_or_offset_changed"}
    window_clock_verified = (len(timed) == len(rows) and monotonic_validated == len(rows)
                             and not clock_issues.intersection(issues))
    overlapping_pairs = 0
    if len(timed) == len(rows):
        timed.sort()
        bounds = (interval(task_events[0]) if task_events else context["fullTaskBounds"]
                  or (timed[0][0], max(item[1] for item in timed)))
        if task_events:
            task_event = task_events[0]
            reference = clock_offsets[0] if clock_offsets else None
            window_clock_verified = (window_clock_verified and reference is not None
                and task_event.get("clockSource", "legacy_unspecified") in clock_sources
                and all(type(task_event.get(key)) is int and task_event[key] >= 0
                        and abs(moment-task_event[key]/1e6-reference) <= clock_tolerance
                        for key, moment in zip(("startedMonotonicNs", "endedMonotonicNs"), bounds)))
            if context["fullTaskBounds"] and any(abs(a-b) > clock_tolerance for a,b in zip(bounds,context["fullTaskBounds"])):
                raise ValueError("The task interval conflicts with task start/response milestones.")
        elif context["fullTaskBounds"]:
            window_clock_verified = window_clock_verified and bool(context["fullTaskClockVerified"])
        if window_kind == "task" and not window_clock_verified:
            issues.append("external_task_clock_unverified")
        if any(start < bounds[0] or end > bounds[1] for start, end, _ in timed):
            raise ValueError("The task interval must contain every CLI call.")
        window_ms = bounds[1] - bounds[0]
        cursor = bounds[0]
        for position, (start, end, index) in enumerate(timed):
            for prior_start, prior_end, prior_index in timed[:position]:
                if intersection((start,end),(prior_start,prior_end)) == 0:
                    continue
                overlapping_pairs += 1
                linked = True
                for item_index, item_start, item_end in ((index,start,end),(prior_index,prior_start,prior_end)):
                    host = context["hostById"].get(context["rowIds"].get(item_index))
                    linked = linked and bool(host and host["_bounds"][0] <= item_start and item_end <= host["_bounds"][1])
                if not linked:
                    issues.append("overlapping_calls")
                elif (number(rows[index].get("actionCount")) != 0
                      and number(rows[prior_index].get("actionCount")) != 0):
                    issues.append("overlapping_mutations")
            if start > cursor:
                gaps.append((cursor, start))
            cursor = max(cursor, end)
            row = rows[index]
            timeline.append({"callId": row.get("callId"), "command": row.get("command"),
                             "hostCallId": context["rowIds"].get(index),
                             "startOffsetMs": rounded(start - bounds[0]),
                             "endOffsetMs": rounded(end - bounds[0]), "elapsedMs": row.get("elapsedMs"),
                             "coreWallMs": (row.get("profile") or {}).get("coreWallMs"),
                             "success": row.get("success"), "runStatus": row.get("runStatus")})
        if cursor < bounds[1]:
            gaps.append((cursor, bounds[1]))
        cli_busy = window_ms - sum(end - start for start, end in gaps)
        annotated = sorted(((*interval(event), event["kind"]) for event in phases))
        previous_end = None
        for start, end, kind in annotated:
            if start < bounds[0] or end > bounds[1]:
                raise ValueError("Phase annotations must be inside the measured window.")
            if previous_end is not None and start < previous_end:
                raise ValueError("Phase annotations overlap; attribution would be ambiguous.")
            previous_end = end
            attributed = sum(intersection((start, end), gap) for gap in gaps)
            phase_totals[kind] += attributed
            annotated_totals[kind] += end - start
            phase_overlap += end - start - attributed
            if kind == "screenshot" and not any(rows[index].get("command") == "screenshot"
                                                and intersection((start, end), (call_start, call_end)) > 0
                                                for call_start, call_end, index in timed):
                screenshot_events += 1
    elif task_events or phases:
        raise ValueError("Phase attribution requires start/end timestamps on every call.")

    gap_ms = sum(end - start for start, end in gaps) if window_ms is not None else None
    usage = manifest.get("modelUsage", {})
    if not isinstance(usage, dict):
        usage = {}
    actual_usage = usage.get("source") in {"provider_usage", "host_usage_counter"}
    byte_metrics = {}
    for field in ("stdoutBytes", "stderrBytes", "emittedBytes"):
        measured = [row[field] for row in rows if number(row.get(field)) is not None]
        byte_metrics[field] = sum(measured) if measured else None
        byte_metrics[field + "MeasuredCalls"] = len(measured)
    result = {"schemaVersion": 1, "kind": "harmony-performance-summary",
              "calls": len(rows), "commands": dict(commands), "packageVersions": sorted(versions),
              "monotonicValidatedCalls": monotonic_validated,
              "clockSources": sorted(clock_sources), "clockToleranceMs": clock_tolerance,
              "windowKind": window_kind, "windowBasis": window_basis, "windowMs": rounded(window_ms),
              "windowClockVerified": window_clock_verified,
              "recordedExecutionModes": context["modes"],
              "executionMode": manifest.get("executionMode") if manifest.get("executionMode") in EXECUTION_MODES else None,
              "hostCalls": context["host"], "overlappingCliPairs": overlapping_pairs,
              "declaredPlanBoundaries": context["planBoundaries"],
              "planBoundaryReasons": dict(Counter(item["reason"] or "undeclared" for item in context["planBoundaries"])),
              "milestones": context["milestones"], "milestoneDurationsMs": context["milestoneDurationsMs"],
              "milestoneDurationClockVerified": context["milestoneDurationClockVerified"],
              "milestoneIssues": context["milestoneIssues"],
              "cliWallSumMs": rounded(sum(durations)), "cliBusyMs": rounded(cli_busy),
              "coreWallSumMs": rounded(sum(core_times)) if core_times else None,
              "coreProfiledCalls": len(core_times), "processOutsideCoreSumMs": rounded(sum(outside_times)) if outside_times else None,
              "outsideCoreMeasuredCalls": len(outside_times),
              "gapMs": rounded(gap_ms), "gapAttributionMs": {key: rounded(value) for key, value in phase_totals.items()},
              "annotatedPhaseMs": {key: rounded(value) for key, value in annotated_totals.items()},
              "manualWaitMs": rounded(annotated_totals["manual_wait"]),
              "unattributedGapMs": rounded(gap_ms - sum(phase_totals.values())) if gap_ms is not None else None,
              "annotatedTimeOverlappingCliMs": rounded(phase_overlap),
              "profileStagesMs": {key: rounded(value) for key, value in stages.items()},
              "profileCounts": dict(counts), "captureStagesMs": {key: rounded(value) for key, value in capture_stages.items()},
              "instrumentedCaptures": instrumented_captures,
              "captureHdcCalls": capture_hdc_calls if instrumented_captures else None,
              "nativeExportMs": None, "transferMs": None,
              "actionCount": action_count if action_rows else None, "actionCountedCalls": action_rows,
              "actionCommands": actions, "captures": captures if capture_rows else None,
              "captureCountedCalls": capture_rows, "runStatuses": dict(statuses),
              "failedCalls": sum(row.get("success") is not True or row.get("emittedExitCode", row.get("exitCode")) != 0 for row in rows),
              "failedRuns": sum(row.get("command") in PLAN_COMMANDS and row.get("runStatus") not in {"completed", "yielded"} for row in rows),
              "unverifiedRuns": sum(row.get("command") in PLAN_COMMANDS and row.get("goalVerification") != "passed" for row in rows),
              "sessionCleanupStatuses": dict(Counter(row["sessionCleanupStatus"] for row in rows
                  if row.get("sessionCleanupStatus") in ("detached", "retained", "failed", "unknown"))),
              "cleanupFailures": sum(row.get("sessionCleanupStatus") == "failed" for row in rows),
              "screenshotCalls": commands.get("screenshot", 0),
              "screenshotEvents": screenshot_events,
              **byte_metrics,
              "modelMs": rounded(phase_totals["model"]) if any(event.get("kind") == "model" for event in phases) else None,
              "modelTimeSource": "explicit_gap_annotations" if any(event.get("kind") == "model" for event in phases) else None,
              "inputTokens": number(usage.get("inputTokens")) if actual_usage else None,
              "outputTokens": number(usage.get("outputTokens")) if actual_usage else None,
              "modelUsageSource": usage.get("source") if actual_usage else None,
              "timingIssues": sorted(set(issues)), "timeline": timeline, "match": matching_metadata(manifest),
              "notes": ["Profile stages can nest; do not sum them as disjoint costs.",
                        "Process time outside core includes startup, parsing, output and other work; it is not measured startup time.",
                        "Unattributed gaps are not model time. Annotations are evaluator-supplied, not automatic measurements.",
                        "A recorded-call window excludes preparation before the first call and work after the final call.",
                        "Host calls, plan boundaries and milestones are caller-supplied evidence; CLI counts do not establish host call counts.",
                        "External UTC-only event durations are annotations, not verified shared-clock measurements."]}
    return result


def compare(baseline, candidate, mode):
    """Refuse a performance claim until workload and comparison axis match."""
    reasons = []
    if mode not in {"strategy", "core"}:
        raise ValueError("Comparison mode must be strategy or core.")
    for name, summary in (("baseline", baseline), ("candidate", candidate)):
        if summary.get("kind") != "harmony-performance-summary":
            reasons.append(name + ":invalid_summary")
        if summary.get("timingIssues") or number(summary.get("windowMs")) is None:
            reasons.append(name + ":incomplete_timeline")
        if summary.get("windowClockVerified") is not True:
            reasons.append(name + ":window_clock_unverified")
        if summary.get("milestoneIssues"):
            reasons.append(name + ":milestone_inconsistent")
        goal_milestone = object_value(summary.get("milestones"), "milestones").get("goal_verified")
        if goal_milestone and (goal_milestone.get("verificationStatus") != "passed" or goal_milestone.get("passed") is not True):
            reasons.append(name + ":goal_milestone_not_verified")
        if summary.get("failedCalls") != 0 or summary.get("failedRuns") != 0:
            reasons.append(name + ":failed_execution")
        if summary.get("cleanupFailures", 0) != 0:
            reasons.append(name + ":cleanup_failed")
        if summary.get("manualWaitMs", 0) > 0 or summary.get("gapAttributionMs", {}).get("manual_wait", 0) > 0:
            reasons.append(name + ":manual_wait_present")
    a, b = baseline.get("match", {}), candidate.get("match", {})
    if not isinstance(a, dict) or not isinstance(b, dict):
        raise ValueError("Comparison matching metadata must be an object.")
    for field in MATCH_FIELDS:
        if field not in a or field not in b:
            reasons.append("missing:" + field)
        elif a[field] != b[field]:
            reasons.append("mismatch:" + field)
    for name, summary, meta in (("baseline", baseline, a), ("candidate", candidate, b)):
        for field in ("taskId", "taskRevision", "initialStateId", "expectedOutcomeId", "verificationSpecId",
                      "environmentId", "modelConfigId", "coreId", "strategyId"):
            if not isinstance(meta.get(field), str) or not meta[field].strip():
                reasons.append(name + ":missing_" + field)
        if meta.get("executionMode") not in EXECUTION_MODES:
            reasons.append(name + ":unknown_execution_mode")
        sequence = meta.get("actionSequence")
        if not isinstance(sequence, list) or not all(isinstance(value, str) and value for value in sequence):
            reasons.append(name + ":invalid_action_sequence")
        elif summary.get("actionCount") != len(sequence) or len(summary.get("actionCommands", [])) != len(sequence):
            reasons.append(name + ":action_count_mismatch")
        required = meta.get("requiredScreenshots")
        completed = meta.get("completedScreenshots")
        if not isinstance(required, list) or not all(isinstance(value, str) and value for value in required) or len(set(required)) != len(required):
            reasons.append(name + ":invalid_screenshot_requirements")
        elif completed != required:
            reasons.append(name + ":screenshots_unverified")
        elif summary.get("screenshotCalls", 0) + summary.get("screenshotEvents", 0) < len(required):
            reasons.append(name + ":screenshots_unrecorded")
        result = meta.get("result")
        if (not isinstance(result, dict) or result.get("status") != "passed"
                or result.get("verifiedOutcomeId") != meta.get("expectedOutcomeId")
                or result.get("verificationMethod") not in {"independent_readback", "independent_evidence_review"}):
            reasons.append(name + ":outcome_unverified")
    fixed, changed = ("coreId", "strategyId") if mode == "strategy" else ("strategyId", "coreId")
    if a.get(fixed) != b.get(fixed):
        reasons.append("mismatch:" + fixed)
    if a.get(changed) == b.get(changed):
        reasons.append("unchanged:" + changed)
    for field in ("windowKind", "windowBasis", "clockSources", "actionCommands", "screenshotCalls", "screenshotEvents"):
        if baseline.get(field) != candidate.get(field):
            reasons.append("mismatch:" + field)
    if mode == "strategy" and baseline.get("packageVersions") != candidate.get("packageVersions"):
        reasons.append("mismatch:packageVersions")
    before, after = number(baseline.get("windowMs")), number(candidate.get("windowMs"))
    if before == 0:
        reasons.append("zero_baseline_window")
    matched = not reasons
    return {"schemaVersion": 1, "kind": "harmony-performance-comparison", "mode": mode,
            "status": "matched_observation" if matched else "not_comparable", "reasons": sorted(set(reasons)),
            "metric": baseline.get("windowKind", "recorded_calls") + "_window_ms",
            "baselineMs": before, "candidateMs": after,
            "timeReductionPercent": rounded((1 - after / before) * 100) if matched else None,
            "notes": ["Matching IDs and outcome review are evaluator declarations; this tool cannot verify their truth.",
                      "One matched pair measures one task attempt, not general speed, reliability or token savings.",
                      "Repeat paired tasks with balanced order and identical model settings before drawing broader conclusions."]}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    summarize_parser = sub.add_parser("summarize", help="Summarize calls.ndjson without reading raw output")
    summarize_parser.add_argument("record_dir")
    summarize_parser.add_argument("--manifest")
    summarize_parser.add_argument("--events")
    summarize_parser.add_argument("--output")
    compare_parser = sub.add_parser("compare", help="Compare two summaries after matching task and result evidence")
    compare_parser.add_argument("baseline")
    compare_parser.add_argument("candidate")
    compare_parser.add_argument("--mode", choices=("strategy", "core"), required=True)
    compare_parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        if args.command == "summarize":
            rows = [json.loads(line) for line in (Path(args.record_dir) / "calls.ndjson").read_text(encoding="utf-8-sig").splitlines() if line.strip()]
            result = summarize(rows, manifest=read_json(args.manifest) if args.manifest else None,
                               events=read_json(args.events) if args.events else None)
        else:
            result = compare(read_json(args.baseline), read_json(args.candidate), args.mode)
        encoded = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            Path(args.output).write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
        return 2 if result.get("status") == "not_comparable" else 0
    except (OSError, ValueError, TypeError) as exc:
        print("Performance input error: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
