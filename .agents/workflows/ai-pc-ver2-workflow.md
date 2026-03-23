---
description: ai-pc-ver2-Workflow
---

🔄 2. 작동 워크플로우 (Workflow)
Request 수신: GET /api/reco?base={기준_it_id}&type={value|alt|upgrade} 형태의 요청을 받는다.

Validation (검증): 필수 파라미터(base, type) 유효성을 검사한다. 실패 시 Fallback 로직 실행.

Base Data 조회: 캐시된 전체 데이터에서 base에 해당하는 기준 PC의 상세 스펙(가격, 성능 등)을 불러온다.

Filtering (1차 필터): 캐시 데이터 중 품절 상품을 제외하고, it_id가 '2'로 시작하는 완제 PC 목록만 추려낸다.

Scoring & Selection (2차 연산): 요청된 type 규칙(Rule 4)에 맞춰 1차 필터링된 목록의 가격대와 성능을 비교 계산하여, 조건에 가장 잘 맞는 단일 대안 상품의 it_id를 추출한다.

Redirect (응답): 추출된 it_id를 자사몰 URL 포맷에 합성하여 302 리다이렉트 응답을 보낸다.