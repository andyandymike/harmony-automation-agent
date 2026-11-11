"""Timing attribution and matched comparisons must not invent performance evidence."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/performance.py"
SPEC = importlib.util.spec_from_file_location("performance", SCRIPT)
performance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(performance)


def at(milliseconds):
    return (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=milliseconds)).isoformat()


def call(start, end, command="press", *, actions=None, core=40):
    actions = [command] if actions is None and command in {"press", "fill", "scroll", "open", "back"} else actions or []
    return {"callId": str(start), "command": command, "startedAt": at(start), "endedAt": at(end),
            "startedMonotonicNs": int(start * 1000000), "endedMonotonicNs": int(end * 1000000),
            "clockSource": "python.perf_counter_ns",
            "elapsedMs": end-start, "success": True, "exitCode": 0, "emittedExitCode": 0,
            "packageVersion": "0.1.0a7", "actionCommands": actions, "actionCount": len(actions),
            "captureCount": 1, "stdoutBytes": 100, "stderrBytes": 0, "emittedBytes": 100,
            "runStatus": "completed" if command == "run" else None,
            "goalVerification": "passed" if command == "run" else None,
            "profile": {"coreWallMs": core, "stagesMs": {"capture": core * .8},
                        "counts": {"captures": 1, "reusedFrames": 2}}}


def metadata(strategy="atomic", core="revision-a"):
    return {"taskId": "counter", "taskRevision": "1", "initialStateId": "zero", "expectedOutcomeId": "two",
            "verificationSpecId": "exact-counter-readback",
            "actionSequence": ["increment", "increment"], "requiredScreenshots": [], "completedScreenshots": [],
            "environmentId": "synthetic-device-a", "modelConfigId": "none", "coreId": core, "strategyId": strategy,
            "executionMode": "cold_setup",
            "result": {"status": "passed", "verifiedOutcomeId": "two", "verificationMethod": "independent_readback"}}


def pair():
    baseline = performance.summarize([call(0, 100), call(400, 500)], manifest=metadata())
    candidate = performance.summarize([call(0, 300, "run", actions=["press", "press"])],
                                      manifest=metadata("batched"))
    return baseline, candidate


def host_event(host_id, start, end, *, clock=False):
    result = {"kind": "host_call", "hostCallId": host_id, "startedAt": at(start), "endedAt": at(end), "source": "harness"}
    if clock:
        result.update(startedMonotonicNs=int(start*1e6), endedMonotonicNs=int(end*1e6), clockSource="python.perf_counter_ns")
    return result


def milestone(name, when, *, clock=False):
    result = {"kind": "milestone", "name": name, "at": at(when), "source": "harness"}
    if name == "goal_verified":
        result.update(verificationMethod="independent_readback",passed=True)
    if clock:
        result.update(monotonicNs=int(when*1e6), clockSource="python.perf_counter_ns")
    return result


class PerformanceTests(unittest.TestCase):
    def test_explicit_cleanup_failure_blocks_a_completed_task_speed_comparison(self):
        baseline, _ = pair()
        row = call(0, 300, "execute", actions=["press", "press"])
        row.update(runStatus="completed", goalVerification="passed", sessionCleanupStatus="failed")
        candidate = performance.summarize([row], manifest=metadata("batched"))
        self.assertEqual(candidate["failedRuns"], 0)
        self.assertEqual(candidate["cleanupFailures"], 1)
        self.assertEqual(candidate["sessionCleanupStatuses"], {"failed": 1})
        comparison = performance.compare(baseline, candidate, "strategy")
        self.assertEqual("not_comparable", comparison["status"])
        self.assertIn("candidate:cleanup_failed", comparison["reasons"])
        self.assertIsNone(comparison["timeReductionPercent"])

    def test_legacy_missing_cleanup_status_is_unknown_rather_than_failure(self):
        baseline, candidate = pair()
        self.assertEqual(baseline["cleanupFailures"], 0)
        self.assertEqual(baseline["sessionCleanupStatuses"], {})
        self.assertEqual("matched_observation", performance.compare(baseline, candidate, "strategy")["status"])
        del baseline["cleanupFailures"]
        self.assertEqual("matched_observation", performance.compare(baseline, candidate, "strategy")["status"])

    def test_execute_failure_is_not_a_successful_zero_action_cli(self):
        row = call(0, 100, "execute", actions=["fill", "press"])
        row.update(runStatus="unknown", goalVerification="unknown", declaredPlanBoundary="recovery")
        result = performance.summarize([row])
        self.assertEqual(result["failedRuns"], 1)
        self.assertEqual(result["unverifiedRuns"], 1)
        self.assertEqual(result["actionCommands"], ["fill", "press"])

    def test_gap_and_process_outside_core_are_distinct_and_model_is_unknown(self):
        result = performance.summarize([call(0, 100, core=60), call(500, 600, core=70)])
        self.assertEqual(result["windowMs"], 600)
        self.assertEqual(result["cliBusyMs"], 200)
        self.assertEqual(result["cliWallSumMs"], 200)
        self.assertEqual(result["coreWallSumMs"], 130)
        self.assertEqual(result["processOutsideCoreSumMs"], 70)
        self.assertEqual(result["gapMs"], 400)
        self.assertEqual(result["unattributedGapMs"], 400)
        self.assertEqual(result["coreProfiledCalls"], 2)
        self.assertEqual(result["profileStagesMs"]["capture"], 104)
        self.assertIsNone(result["modelMs"])
        self.assertIsNone(result["inputTokens"])
        self.assertIsNone(result["nativeExportMs"])

    def test_explicit_phases_attribute_only_gaps_without_double_counting_cli(self):
        events = [{"kind": "request_build", "startedAt": at(50), "endedAt": at(150)},
                  {"kind": "model", "startedAt": at(200), "endedAt": at(400)}]
        result = performance.summarize([call(0, 100), call(500, 600)], events=events)
        self.assertEqual(result["gapAttributionMs"], {"request_build": 50, "model": 200})
        self.assertEqual(result["annotatedTimeOverlappingCliMs"], 50)
        self.assertEqual(result["unattributedGapMs"], 150)
        self.assertEqual(result["modelMs"], 200)
        self.assertEqual(result["modelTimeSource"], "explicit_gap_annotations")

    def test_task_bounds_include_preparation_and_finish_when_explicit(self):
        events = [{"kind": "task", "startedAt": at(0), "endedAt": at(1000)}]
        result = performance.summarize([call(100, 200), call(800, 900)], events=events)
        self.assertEqual(result["windowKind"], "task")
        self.assertEqual(result["windowMs"], 1000)
        self.assertEqual(result["gapMs"], 800)
        self.assertEqual(result["timeline"][0]["startOffsetMs"], 100)

    def test_legacy_rows_preserve_totals_without_inventing_a_start_timestamp(self):
        legacy = {"at": at(500), "elapsedMs": 100, "success": True, "exitCode": 0,
                  "stdoutBytes": 200, "command": "observe"}
        result = performance.summarize([legacy])
        self.assertEqual(result["cliWallSumMs"], 100)
        self.assertIsNone(result["windowMs"])
        self.assertIsNone(result["gapMs"])
        self.assertEqual(result["coreProfiledCalls"], 0)
        self.assertIsNone(result["coreWallSumMs"])
        self.assertIn("missing_or_invalid_start_end", result["timingIssues"])

    def test_overlapping_calls_report_union_and_cannot_claim_sequential_speedup(self):
        result = performance.summarize([call(0, 100), call(50, 150)])
        self.assertEqual(result["cliBusyMs"], 150)
        self.assertEqual(result["cliWallSumMs"], 200)
        self.assertEqual(result["gapMs"], 0)
        self.assertIn("overlapping_calls", result["timingIssues"])

    def test_clock_jump_and_impossible_core_time_are_not_clamped_into_good_data(self):
        row = call(0, 100, core=110)
        row["elapsedMs"] = 50
        result = performance.summarize([row])
        self.assertIn("wall_clock_duration_mismatch", result["timingIssues"])
        self.assertIn("core_exceeds_process_wall", result["timingIssues"])
        self.assertIsNone(result["processOutsideCoreSumMs"])

    def test_clock_jump_between_calls_cannot_be_reported_as_a_strategy_gain(self):
        rows = [call(0, 100), call(100400, 100500)]
        rows[1].update(startedMonotonicNs=400000000, endedMonotonicNs=500000000)
        baseline = performance.summarize(rows, manifest=metadata())
        candidate = performance.summarize([call(0, 500, "run", actions=["press", "press"])],
                                          manifest=metadata("batched"))
        self.assertIn("clock_domain_or_offset_changed", baseline["timingIssues"])
        comparison = performance.compare(baseline, candidate, "strategy")
        self.assertEqual(comparison["status"], "not_comparable")
        self.assertIsNone(comparison["timeReductionPercent"])

    def test_missing_monotonic_clock_does_not_silently_enable_comparison(self):
        row = call(0, 100)
        del row["startedMonotonicNs"]
        result = performance.summarize([row])
        self.assertEqual(result["monotonicValidatedCalls"], 0)
        self.assertIn("missing_or_invalid_monotonic_clock", result["timingIssues"])

    def test_overlapping_phase_annotations_are_rejected(self):
        events = [{"kind": "analysis", "startedAt": at(100), "endedAt": at(300)},
                  {"kind": "model", "startedAt": at(200), "endedAt": at(400)}]
        with self.assertRaisesRegex(ValueError, "overlap"):
            performance.summarize([call(0, 100), call(500, 600)], events=events)

    def test_tokens_require_actual_usage_source_not_byte_conversion(self):
        result = performance.summarize([call(0, 100)], manifest={"modelUsage": {"inputTokens": 1234}})
        self.assertIsNone(result["inputTokens"])
        result = performance.summarize([call(0, 100)], manifest={"modelUsage": {
            "source": "host_usage_counter", "inputTokens": 1234, "outputTokens": 45}})
        self.assertEqual(result["inputTokens"], 1234)
        self.assertEqual(result["outputTokens"], 45)

    def test_screenshot_annotation_does_not_count_the_same_cli_capture_twice(self):
        rows = [call(0, 100, "screenshot"), call(500, 600)]
        events = [{"kind": "screenshot", "startedAt": at(0), "endedAt": at(100)},
                  {"kind": "screenshot", "startedAt": at(200), "endedAt": at(300)}]
        result = performance.summarize(rows, events=events)
        self.assertEqual(result["screenshotCalls"], 1)
        self.assertEqual(result["screenshotEvents"], 1)

    def test_extra_manifest_and_profile_text_are_not_copied_to_output(self):
        manifest = metadata()
        manifest["rawUi"] = "private-ui-marker"
        manifest["result"]["actualText"] = "private-ui-marker"
        row = call(0, 100)
        row["profile"]["note"] = "private-ui-marker"
        row["profile"]["captureBreakdown"] = {"instrumentedCaptures": 1, "hdcCalls": 1,
                                                "nativeExportMs": None, "transferMs": None,
                                                "stagesMs": {"hdcProcess": 25, "layoutParseAndValidation": 2}}
        result = performance.summarize([row], manifest=manifest)
        self.assertNotIn("private-ui-marker", json.dumps(result))
        self.assertEqual(result["captureHdcCalls"], 1)
        self.assertEqual(result["captureStagesMs"]["hdcProcess"], 25)

    def test_strategy_pair_matches_same_actions_and_verified_outcome(self):
        baseline, candidate = pair()
        result = performance.compare(baseline, candidate, "strategy")
        self.assertEqual(result["status"], "matched_observation")
        self.assertEqual(result["timeReductionPercent"], 40)
        self.assertEqual(result["metric"], "recorded_calls_window_ms")

    def test_changed_core_cannot_be_sold_as_strategy_improvement(self):
        baseline, candidate = pair()
        candidate["match"]["coreId"] = "revision-b"
        result = performance.compare(baseline, candidate, "strategy")
        self.assertEqual(result["status"], "not_comparable")
        self.assertIsNone(result["timeReductionPercent"])
        self.assertIn("mismatch:coreId", result["reasons"])

    def test_core_comparison_requires_same_strategy_and_allows_new_version(self):
        baseline, candidate = pair()
        candidate["match"].update(coreId="revision-b", strategyId="atomic")
        candidate["packageVersions"] = ["0.1.0a8"]
        result = performance.compare(baseline, candidate, "core")
        self.assertEqual(result["status"], "matched_observation")

    def test_outcome_actions_model_and_required_screenshots_must_match(self):
        for change, reason in (
            (lambda c: c["match"]["result"].update(status="failed"), "candidate:outcome_unverified"),
            (lambda c: c.update(actionCount=1), "candidate:action_count_mismatch"),
            (lambda c: c["match"].update(modelConfigId="different-model"), "mismatch:modelConfigId"),
            (lambda c: c["match"].update(verificationSpecId="different-checks"), "mismatch:verificationSpecId"),
            (lambda c: c["match"].update(requiredScreenshots=["final"], completedScreenshots=["final"]), "candidate:screenshots_unrecorded"),
            (lambda c: c.update(failedRuns=1), "candidate:failed_execution"),
        ):
            with self.subTest(reason=reason):
                baseline, candidate = pair()
                change(candidate)
                result = performance.compare(baseline, candidate, "strategy")
                self.assertIn(reason, result["reasons"])
                self.assertIsNone(result["timeReductionPercent"])

    def test_missing_metadata_and_human_wait_never_produce_a_gain_claim(self):
        baseline, candidate = pair()
        candidate["match"] = {}
        candidate["gapAttributionMs"] = {"manual_wait": 100}
        result = performance.compare(baseline, candidate, "strategy")
        self.assertEqual(result["status"], "not_comparable")
        self.assertIn("candidate:manual_wait_present", result["reasons"])
        self.assertIn("missing:taskId", result["reasons"])

    def test_human_wait_inside_a_cli_call_also_blocks_a_performance_claim(self):
        baseline, _ = pair()
        candidate = performance.summarize([call(0, 300, "run", actions=["press", "press"])],
            manifest=metadata("batched"), events=[{"kind": "manual_wait", "startedAt": at(100), "endedAt": at(200)}])
        self.assertEqual(candidate["gapAttributionMs"]["manual_wait"], 0)
        self.assertEqual(candidate["manualWaitMs"], 100)
        self.assertIn("candidate:manual_wait_present", performance.compare(baseline, candidate, "strategy")["reasons"])

    def test_cli_summary_reads_only_records_not_private_stdout_files(self):
        with tempfile.TemporaryDirectory(prefix="performance 中文 ") as folder:
            root = Path(folder)
            (root / "calls.ndjson").write_text(json.dumps(call(0, 100)) + "\n", encoding="utf-8")
            (root / "0.stdout").write_bytes(b"private-ui-marker")
            output = io.StringIO()
            with patch.object(performance.sys, "stdout", output):
                self.assertEqual(performance.main(["summarize", str(root)]), 0)
            self.assertNotIn("private-ui-marker", output.getvalue())
            self.assertEqual(json.loads(output.getvalue())["calls"], 1)

    def test_one_host_call_can_contain_multiple_concurrent_cli_calls(self):
        rows = [call(0,100,"schema"),call(20,120,"observe")]
        for row in rows:
            row["hostCallId"] = "tool-1"
        result = performance.summarize(rows, events=[host_event("tool-1",0,150)])
        self.assertEqual(result["calls"],2)
        self.assertEqual(result["hostCalls"]["recordedCount"],1)
        self.assertEqual(result["hostCalls"]["cliLinkedToRecordedHost"],2)
        self.assertEqual(result["hostCalls"]["entries"][0]["cliCalls"],2)
        self.assertEqual(result["hostCalls"]["busyMs"],150)
        self.assertFalse(result["hostCalls"]["clockVerified"])
        self.assertEqual(result["overlappingCliPairs"],1)
        self.assertEqual(result["cliBusyMs"],120)
        self.assertEqual(result["timingIssues"],[])

    def test_unknown_host_call_count_is_null_and_ids_only_are_partial_evidence(self):
        rows=[call(0,100),call(400,500)]
        result=performance.summarize(rows)
        self.assertIsNone(result["hostCalls"]["recordedCount"])
        self.assertIsNone(result["hostCalls"]["identifiedCount"])
        rows[0]["hostCallId"]="caller-label"
        result=performance.summarize(rows)
        self.assertIsNone(result["hostCalls"]["recordedCount"])
        self.assertEqual(result["hostCalls"]["identifiedCount"],1)
        self.assertEqual(result["hostCalls"]["cliWithoutId"],1)
        self.assertIsNone(result["hostCalls"]["busyMs"])

    def test_host_intervals_include_non_cli_tools_and_use_union_without_double_counting(self):
        row=call(50,150,"schema")
        row["hostCallId"]="tool-outer"
        result=performance.summarize([row],events=[host_event("tool-outer",0,200,clock=True),
                                                 host_event("read-resource",50,100,clock=True)])
        self.assertEqual(result["hostCalls"]["recordedCount"],2)
        self.assertEqual(result["hostCalls"]["wallSumMs"],250)
        self.assertEqual(result["hostCalls"]["busyMs"],200)
        self.assertEqual(result["hostCalls"]["entries"][1]["cliCalls"],0)
        self.assertTrue(result["hostCalls"]["clockVerified"])

    def test_nested_api_counts_and_parent_labels_do_not_invent_outer_calls_or_model_rounds(self):
        first,second=host_event("api-1",0,100),host_event("api-2",200,300)
        for event in (first,second):
            event.update(boundaryKind="nested_tool_api",outerCallId="outer-1")
        rows=[call(0,100,"schema"),call(200,300,"observe")]
        rows[0]["hostCallId"],rows[1]["hostCallId"]="api-1","api-2"
        result=performance.summarize(rows,events=[first,second])
        self.assertEqual(result["hostCalls"]["nestedToolApiCount"],2)
        self.assertIsNone(result["hostCalls"]["outerToolCallCount"])
        self.assertIsNone(result["hostCalls"]["modelToolRounds"])
        outer=host_event("outer-1",0,350)
        outer["boundaryKind"]="host_tool_call"
        result=performance.summarize(rows,events=[first,second,outer])
        self.assertEqual(result["hostCalls"]["outerToolCallCount"],1)
        self.assertEqual(result["hostCalls"]["nestedToolApiCount"],2)
        self.assertIsNone(result["hostCalls"]["modelToolRounds"])

    def test_overlapping_mutations_remain_ambiguous_even_with_one_host_id(self):
        rows=[call(0,100),call(20,120)]
        for row in rows:row["hostCallId"]="parallel-tool"
        result=performance.summarize(rows,events=[host_event("parallel-tool",0,150)])
        self.assertIn("overlapping_mutations",result["timingIssues"])

    def test_declared_plan_boundary_is_separate_from_actual_status(self):
        row=call(0,100,"run",actions=["press"])
        row.update(declaredPlanBoundary="goal_reached",runStatus="failed",executionMode="warm_continue")
        result=performance.summarize([row],manifest={"executionMode":"warm_continue"})
        self.assertEqual(result["declaredPlanBoundaries"][0]["reason"],"goal_reached")
        self.assertEqual(result["declaredPlanBoundaries"][0]["runStatus"],"failed")
        self.assertEqual(result["failedRuns"],1)
        del row["declaredPlanBoundary"]
        self.assertEqual(performance.summarize([row])["planBoundaryReasons"],{"undeclared":1})

    def test_complete_verified_milestones_define_a_full_response_window(self):
        events=[milestone("task_start",0,clock=True),milestone("goal_verified",400,clock=True),
                milestone("cleanup_complete",500,clock=True),milestone("response_complete",600,clock=True)]
        result=performance.summarize([call(100,200)],events=events)
        self.assertEqual(result["windowBasis"],"task_start_to_response_complete")
        self.assertEqual(result["windowMs"],600)
        self.assertTrue(result["windowClockVerified"])
        self.assertEqual(result["milestoneDurationsMs"],{"toGoalVerifiedMs":400,"toCleanupCompleteMs":500,"toResponseCompleteMs":600})
        self.assertTrue(all(result["milestoneDurationClockVerified"].values()))

    def test_partial_milestones_do_not_guess_response_time_or_trust_external_clocks(self):
        events=[milestone("task_start",0),milestone("goal_verified",300),milestone("cleanup_complete",400)]
        result=performance.summarize([call(100,200)],events=events)
        self.assertEqual(result["windowKind"],"recorded_calls")
        self.assertEqual(result["windowMs"],100)
        self.assertIsNone(result["milestones"]["response_complete"])
        self.assertIsNone(result["milestoneDurationsMs"]["toResponseCompleteMs"])
        self.assertEqual(result["milestoneDurationsMs"]["toGoalVerifiedMs"],300)
        self.assertFalse(result["milestoneDurationClockVerified"]["toGoalVerifiedMs"])
        self.assertIsNone(result["milestoneDurationClockVerified"]["toResponseCompleteMs"])

    def test_external_only_full_task_clock_cannot_support_matched_gain(self):
        events=[milestone("task_start",0),milestone("response_complete",600)]
        result=performance.summarize([call(100,200)],events=events)
        self.assertFalse(result["windowClockVerified"])
        self.assertIn("external_task_clock_unverified",result["timingIssues"])

    def test_goal_milestone_requires_independent_verification(self):
        event=milestone("goal_verified",200)
        del event["verificationMethod"]
        with self.assertRaisesRegex(ValueError,"independent"):
            performance.summarize([call(0,100)],events=[event])

    def test_failed_or_unknown_goal_milestone_cannot_become_verified_time_or_a_gain(self):
        for passed in (False,None):
            with self.subTest(passed=passed):
                rows=[call(0,100),call(400,500)]
                events=[milestone("task_start",0,clock=True),milestone("goal_verified",550,clock=True),
                        milestone("cleanup_complete",600,clock=True),milestone("response_complete",700,clock=True)]
                events[1]["passed"]=passed
                result=performance.summarize(rows,manifest=metadata(),events=events)
                self.assertIs(result["milestones"]["goal_verified"]["passed"],passed)
                self.assertIsNone(result["milestoneDurationsMs"]["toGoalVerifiedMs"])
                self.assertIn("goal_not_verified",result["milestoneIssues"])
                self.assertIn("goal_verification_conflicts_with_manifest",result["milestoneIssues"])
                candidate=performance.summarize(rows,manifest=metadata("batched"),events=events)
                comparison=performance.compare(result,candidate,"strategy")
                self.assertEqual(comparison["status"],"not_comparable")
                self.assertIsNone(comparison["timeReductionPercent"])

    def test_provided_milestones_out_of_order_cannot_support_comparison(self):
        rows=[call(0,100),call(400,500)]
        events=[milestone("task_start",0,clock=True),milestone("goal_verified",900,clock=True),
                milestone("cleanup_complete",950,clock=True),milestone("response_complete",800,clock=True)]
        baseline=performance.summarize(rows,manifest=metadata(),events=events)
        candidate=performance.summarize(rows,manifest=metadata("batched"),events=events)
        self.assertIn("milestone_order_invalid",baseline["milestoneIssues"])
        comparison=performance.compare(baseline,candidate,"strategy")
        self.assertIn("baseline:milestone_inconsistent",comparison["reasons"])
        self.assertIsNone(comparison["timeReductionPercent"])

    def test_missing_output_bytes_are_unknown_and_partial_coverage_is_visible(self):
        first,second=call(0,100),call(400,500)
        del first["emittedBytes"]
        result=performance.summarize([first])
        self.assertIsNone(result["emittedBytes"])
        self.assertEqual(result["emittedBytesMeasuredCalls"],0)
        result=performance.summarize([first,second])
        self.assertEqual(result["emittedBytes"],100)
        self.assertEqual(result["emittedBytesMeasuredCalls"],1)
        self.assertEqual(result["stdoutBytesMeasuredCalls"],2)

    def test_cold_and_warm_conditions_must_match_and_unknown_does_not_default(self):
        baseline,candidate=pair()
        candidate["match"]["executionMode"]="warm_continue"
        result=performance.compare(baseline,candidate,"strategy")
        self.assertIn("mismatch:executionMode",result["reasons"])
        self.assertIsNone(result["timeReductionPercent"])
        del candidate["match"]["executionMode"]
        self.assertIn("candidate:unknown_execution_mode",performance.compare(baseline,candidate,"strategy")["reasons"])
        row=call(0,100)
        row["executionMode"]="warm_continue"
        self.assertIn("execution_mode_conflicts_with_manifest",performance.summarize([row],manifest=metadata())["timingIssues"])

    def test_legacy_clock_resolution_is_supported_but_clock_domains_cannot_mix(self):
        rows=[call(0,100),call(400,500)]
        for row in rows:
            row["clockSource"]="python.monotonic_ns"
        rows[1].update(startedMonotonicNs=385000000,endedMonotonicNs=500000000)
        result=performance.summarize(rows)
        self.assertEqual(result["timingIssues"],[])
        self.assertEqual(result["clockToleranceMs"],32)
        rows[1]["clockSource"]="python.perf_counter_ns"
        self.assertIn("mixed_clock_sources",performance.summarize(rows)["timingIssues"])


if __name__ == "__main__":
    unittest.main()
