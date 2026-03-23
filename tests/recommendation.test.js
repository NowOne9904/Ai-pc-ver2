const request = require('supertest');
const { createRecommendationApp } = require('../src/app');

// Supabase Mock
jest.mock('../src/db', () => {
    const mockProducts = [
        { it_id: '2001', it_name: '기준PC', it_price: 1000000, performance: 100, is_soldout: false },
        { it_id: '2002', it_name: '완제PC(재고있음)', it_price: 1300000, performance: 110, is_soldout: false },
        { it_id: '5701', it_name: '모니터(배제대상)', it_price: 900000, performance: 90, is_soldout: false },
        { it_id: '2003', it_name: '완제PC(품절)', it_price: 920000, performance: 92, is_soldout: true },
        { it_id: '2101', it_name: 'A_PC(Value-LowPerf)', it_price: 860000, performance: 85, is_soldout: false },
        { it_id: '2102', it_name: 'A_PC(Value-HighPrice)', it_price: 940000, performance: 95, is_soldout: false },
        { it_id: '2103', it_name: 'A_PC(Value-Target)', it_price: 880000, performance: 98, is_soldout: false },
        { it_id: '2104', it_name: 'B_PC(Alt-PerfOut)', it_price: 1000000, performance: 90, is_soldout: false },
        { it_id: '2105', it_name: 'B_PC(Alt-Target)', it_price: 1020000, performance: 103, is_soldout: false },
        { it_id: '2106', it_name: 'B_PC(Alt-FarPrice)', it_price: 1040000, performance: 98, is_soldout: false },
        { it_id: '2107', it_name: 'C_PC(Upgrade-LowPerf)', it_price: 1150000, performance: 110, is_soldout: false },
        { it_id: '2108', it_name: 'C_PC(Upgrade-Target)', it_price: 1180000, performance: 125, is_soldout: false },
        { it_id: '2999', it_name: '기본 추천 PC', it_price: 800000, performance: 80, is_soldout: false }
    ];
    return {
        supabase: {
            from: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue({ data: mockProducts, error: null })
        }
    };
});

const DEFAULT_PC_ID = '2999';

describe('AI PC Recommendation TDD Scenarios with Supabase', () => {
    let app;

    beforeAll(() => {
        app = createRecommendationApp(DEFAULT_PC_ID);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[Test Suite 1: 파라미터 검증 (Validation)]', () => {
        test('Test 1-1: base 파라미터가 누락된 경우, HTTP 302와 함께 "기본 추천 PC" URL로 리다이렉트 되는가?', async () => {
            const response = await request(app).get('/recommend');
            expect(response.status).toBe(302);
            expect(response.header.location).toBe(`/product/${DEFAULT_PC_ID}`);
        });

        test('Test 1-2: type 파라미터에 "value", "alt", "upgrade" 외의 값이 들어왔을 때, HTTP 302와 함께 "기준 PC(base)" URL로 리다이렉트 되는가?', async () => {
            const response = await request(app).get('/recommend?base=2001&type=invalid');
            expect(response.status).toBe(302);
            expect(response.header.location).toBe('/product/2001');
        });
    });

    describe('[Test Suite 2: 식별자(ID) 및 재고 필터링 검증]', () => {
        test('Test 2-1: 조건에 부합하더라도 it_id가 "57"로 시작하는 상품(모니터)은 완제 PC 추천 결과에서 완벽히 배제되는가?', async () => {
            const response = await request(app).get('/recommend?base=2001&type=value');
            const targetId = response.header.location.split('/').pop();
            expect(targetId.startsWith('57')).toBe(false);
        });

        test('Test 2-2: is_soldout이 true인 상품은 추천 결과에서 제외되는가?', async () => {
            const response = await request(app).get('/recommend?base=2001&type=value');
            const targetId = response.header.location.split('/').pop();
            expect(targetId).not.toBe('2003');
        });

        test('Test 2-3: 최종 반환되는 추천 상품의 it_id는 반드시 "2"로 시작하는가?', async () => {
            const types = ['value', 'alt', 'upgrade'];
            for (const type of types) {
                const response = await request(app).get(`/recommend?base=2001&type=${type}`);
                const targetId = response.header.location.split('/').pop();
                expect(targetId.startsWith('2')).toBe(true);
            }
        });
    });

    describe('[Test Suite 3: 타입별 대안 상품 매칭 로직 검증]', () => {
        test('Test 3-1 (Value): type=value 요청 시, 성능 90% 이상 중 가장 저렴한 2103으로 리다이렉트 되는가?', async () => {
            const response = await request(app).get('/recommend?base=2001&type=value');
            expect(response.header.location).toBe('/product/2103');
        });

        test('Test 3-2 (Alt): type=alt 요청 시, 성능 95~105% 오차범위 내이고 기준가와 가격이 가장 가까운 2105로 리다이렉트 되는가?', async () => {
            const response = await request(app).get('/recommend?base=2001&type=alt');
            expect(response.header.location).toBe('/product/2105');
        });

        test('Test 3-3 (Upgrade): type=upgrade 요청 시, 성능이 더 높고 110~120% 가격대 내에서 가장 성능이 높은 2108으로 리다이렉트 되는가?', async () => {
            const response = await request(app).get('/recommend?base=2001&type=upgrade');
            expect(response.header.location).toBe('/product/2108');
        });
    });

    describe('[Test Suite 4: 엣지 케이스 및 폴백 (Edge Cases)]', () => {
        test('Test 4-1: type=value를 요청했으나, 조건을 만족하는 상품이 없을 경우 기준 PC로 302 리다이렉트 처리되는가?', async () => {
            const response = await request(app).get('/recommend?base=2999&type=value');
            expect(response.status).toBe(302);
            expect(response.header.location).toBe('/product/2999');
        });

        test('Test 4-2: URL에 전달된 base 식별자가 존재하지 않는 경우 기본 추천 PC로 302 리다이렉트 처리되는가?', async () => {
            const response = await request(app).get('/recommend?base=NON_EXISTENT&type=value');
            expect(response.status).toBe(302);
            expect(response.header.location).toBe(`/product/${DEFAULT_PC_ID}`);
        });
    });
});
