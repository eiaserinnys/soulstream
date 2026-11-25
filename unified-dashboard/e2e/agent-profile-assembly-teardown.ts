// 시각 검수가 끝나면 시험들이 쓴 조작 결과 두 조각을 .local/shots/operations.md 하나로 합친다.
import { composeOperations } from "./agent-profile-assembly-guides-helpers";

export default function globalTeardown() {
  composeOperations();
}
