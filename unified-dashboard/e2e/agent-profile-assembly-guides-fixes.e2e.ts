// 세라피엘 화면 검수(카드 #1854)의 지적 완료 조건 측정. 긴 측정이라 다른 파일로 두어 두 번째 worker가 맡게 한다.
import { test } from "@playwright/test";
import { LONGEST_SKILL_NAME } from "../client/v3/guides-fixture";
import { measureFixes } from "./agent-profile-assembly-guides-fixcheck";
import { writeFixes } from "./agent-profile-assembly-guides-helpers";

test("fixes: 세라피엘 화면 검수(1차 결함 여섯, 권함 둘, 못 본 것 둘과 2차 결함 A, B)의 완료 조건을 잰다", async ({ page }) => {
  test.setTimeout(420_000);
  writeFixes(await measureFixes(page, LONGEST_SKILL_NAME));
});
