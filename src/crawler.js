require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { supabase } = require('./db');

const TARGET_URL = 'https://www.youngjaecomputer.com/shop/list.php?ca_id=h0&ca_id_vi=364&ca_id_index=19';

function calculatePerformance(title, detailText = '', it_price = 0) {
    const dict = {
        'GTX 1660': 60,
        'RTX 3060': 80,
        'RTX 4060 TI': 110,
        'RTX 4060': 100,
        'RTX 4070 TI': 140,
        'RTX 4070': 130,
        'RTX 4080': 160,
        'RTX 4090': 200,
        'RTX 5060': 120
    };

    // title과 detailText를 모두 합쳐서 스캔
    const combinedText = (title + ' ' + detailText).toUpperCase();
    let maxScore = 0;

    for (const [key, score] of Object.entries(dict)) {
        if (combinedText.includes(key)) {
            if (score > maxScore) {
                maxScore = score;
            }
        }
    }

    if (maxScore > 0) return maxScore;

    // 가격 기반 성능 보정 (Price-based Fallback)
    if (it_price >= 2500000) return 160;
    if (it_price >= 2000000) return 140;
    if (it_price >= 1500000) return 120;

    return 100;
}

async function scrapeAndSync() {
    try {
        console.log(`[Crawler] 1차 Fetching data from: ${TARGET_URL}`);
        const { data: html } = await axios.get(TARGET_URL);
        const $ = cheerio.load(html);

        const extractedMap = new Map();

        // 1차 추출: 리스트 목록 파싱
        $('a[href*="it_id="]').each((index, element) => {
            const href = $(element).attr('href');
            const match = href.match(/it_id=(\d+)/);
            if (!match) return;
            const it_id = match[1];

            if (!it_id.startsWith('2')) return;
            if (extractedMap.has(it_id)) return;

            const container = $(element).closest('td, li');
            if (!container.length) return;

            const textLines = $(element).text().split('\n').map(s => s.trim()).filter(s => s.length > 0);
            if (textLines.length === 0) return;

            const title = textLines[0];

            let it_price = 0;
            for (let i = textLines.length - 1; i >= 0; i--) {
                if (textLines[i].includes('원')) {
                    it_price = parseInt(textLines[i].replace(/[^0-9]/g, ''), 10);
                    break;
                }
            }

            const is_soldout_by_text = textLines.some(line => line.includes('품절') || line.includes('soldout'));
            const is_soldout_by_img = $(element).find('img[src*="soldout"]').length > 0;
            const is_soldout = is_soldout_by_text || is_soldout_by_img;

            if (title && it_price > 0) {
                extractedMap.set(it_id, {
                    it_id,
                    title,
                    it_price,
                    is_soldout
                });
            }
        });

        const extractedList = Array.from(extractedMap.values());
        console.log(`[Crawler] 1차 리스트 파싱 완료: 총 ${extractedList.length}개의 완제 PC 상품 파싱됨.`);

        if (extractedList.length === 0) {
            console.log('[Crawler] 주의: 파싱된 데이터가 없습니다.');
            return;
        }

        console.log(`[Crawler] --- 2차 상세 페이지 딥 크롤링 (Deep Crawling) 시작 ---`);
        const finalProducts = [];

        // 비동기 순차 루프 (상세 페이지 조회 및 스펙 추출)
        for (const item of extractedList) {
            const detailUrl = `https://www.youngjaecomputer.com/shop/item.php?it_id=${item.it_id}`;
            try {
                const { data: detailHtml } = await axios.get(detailUrl);
                const $$ = cheerio.load(detailHtml);

                // 상세 페이지의 본문 특정 영역(영카트 구조) 텍스트 추출 (데이터 오염 방지)
                let detailText = ($$('#sit_inf').text() + ' ' + $$('#sit_pvi').text() + ' ' + $$('#sit_tab').text() + ' ' + $$('#item_content').text() + ' ' + $$('.sit_info').text()).replace(/\s+/g, ' ');

                // 추가 방어: 만약 스펙이 텍스트가 아니라 이미지로 박혀있을 경우 (한국형 쇼핑몰 특징)
                // 이미지의 파일명(src)이나 설명(alt)에 RTX 4070 등이 들어있을 수 있으므로 이 또한 스캔 대상에 포함
                $$('#sit_inf img, #sit_pvi img, #sit_tab img, #item_content img, .sit_info img').each((i, el) => {
                    const src = $$(el).attr('src') || '';
                    const alt = $$(el).attr('alt') || '';
                    detailText += ' ' + src + ' ' + alt;
                });

                // URL 인코딩된 파일명 대응
                try { detailText = decodeURIComponent(detailText); } catch (e) { }

                // 결합 로직으로 성능 분석
                item.performance = calculatePerformance(item.title, detailText, item.it_price);
                finalProducts.push(item);

                console.log(`  -> [딥 크롤링 성공] ID: ${item.it_id} | 분석 점수: ${item.performance}점 | 상품명: ${item.title.substring(0, 30)}...`);
            } catch (err) {
                console.error(`  -> [딥 크롤링 에러] ID: ${item.it_id} 로드 실패:`, err.message);
                // 에러 시 타이틀로만 분석한 기본값 부여
                item.performance = calculatePerformance(item.title, '', item.it_price);
                finalProducts.push(item);
            }

            // 서버 보호 (DDoS 방어)용 딜레이: 필수 요소
            await new Promise(r => setTimeout(r, 500));
        }

        console.log('-----------------------------');
        console.log('[Crawler] Supabase pc_products 테이블에 Upsert 중 (기준: it_id)...');

        let successCount = 0;
        for (const product of finalProducts) {
            // 수동 Upsert 로직
            const { data: existing } = await supabase
                .from('pc_products')
                .select('it_id')
                .eq('it_id', product.it_id)
                .maybeSingle();

            if (existing) {
                const { error } = await supabase
                    .from('pc_products')
                    .update({
                        title: product.title,
                        it_price: product.it_price,
                        is_soldout: product.is_soldout,
                        performance: product.performance // 점수도 같이 업데이트
                    })
                    .eq('it_id', product.it_id);
                if (error) throw error;
            } else {
                const { error } = await supabase
                    .from('pc_products')
                    .insert([product]);
                if (error) throw error;
            }
            successCount++;
        }

        console.log(`[Crawler] Supabase DB 동기화 성공! 삽입/수정된 상품 수: ${successCount}`);

    } catch (error) {
        console.error('[Crawler] 크롤링/동기화 중 치명적 에러 발생:', error.message);
    }
}

if (require.main === module) {
    scrapeAndSync();
}

module.exports = { scrapeAndSync };
