// 확인용 시안: 운영 검수 창(/components)의 본문을 그대로 올린다.
// 같은 컴포넌트, 같은 샘플 데이터이므로 운영 빌드와 화소 단위로 견줄 수 있다.
import { mockImages } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { ComponentsReviewPage } from "../../client/v3/ComponentsReviewPage";

// 검수 견본이 서버에서 받던 첨부 그림.
mockImages([{ pattern: /^\/api\/attachments\/files$/, file: "icon-512.png" }]);

mountMockup(<ComponentsReviewPage />);
