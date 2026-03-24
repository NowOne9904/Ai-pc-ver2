require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { supabase } = require('./db');

// 확장된 다중 카테고리 배열
const CATEGORY_URLS = [
    'https://www.youngjaecomputer.com/shop/list.php?ca_id=h0&ca_id_vi=364&ca_id_index=19', // 기존: AI 추천장바구니 (상품 4개)
    'https://www.youngjaecomputer.com/shop/list.php?ca_id=h0' // 추가: 스탠다드 PC 전체 (상품 수백개)
];

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

    if (it_price >= 2500000) return 160;
    if (it_price >= 2000000) return 140;
    if (it_price >= 1500000) return 120;

    return 100;
}

async function scrapeAndSync() {
    try {
        const finalProducts = [];
        const extractedMap = new Map();

        // 1. 카테고리 및 페이지네이션 무한 루프
        for (const baseUrl of CATEGORY_URLS) {
            let page = 1;
            while (true) {
                const targetUrl = `${baseUrl}&page=${page}`;
                console.log(`\n[Crawler] 1차 Fetching data from: ${targetUrl}`);

                const { data: html } = await axios.get(targetUrl);
                const $ = cheerio.load(html);

                // 현재 페이지에 상품이 존재하는지 확인 (없으면 반복 중단)
                const itemsCount = $('li.sct_li').length;
                if (itemsCount === 0) {
                    console.log(`[Crawler] 페이지 ${page}에 더 이상 상품이 없습니다. 다음 카테고리로 넘어갑니다.`);
                    break;
                }

                console.log(`[Crawler] ${page}페이지 리스트 파싱 완료: 총 ${itemsCount}개의 요소 발견`);

                // 한 페이지 상품 목록 파싱
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
                            it_id, title, it_price, is_soldout
                        });
                    }
                });

                // 페이지 루프 지속
                page++;
            }
        }

        const extractedList = Array.from(extractedMap.values());
        console.log(`\n[Crawler] 전체 1차 리스트 파싱 완료: 총 ${extractedList.length}개의 완제 PC 상품 수집됨.`);

        if (extractedList.length === 0) {
            console.log('[Crawler] 주의: 파싱된 데이터가 없습니다.');
            return;
        }

        console.log(`\n[Crawler] --- 2차 상세 페이지 딥 크롤링 (Deep Crawling) 시작 ---`);

        for (const item of extractedList) {
            const detailUrl = `https://www.youngjaecomputer.com/shop/item.php?it_id=${item.it_id}`;
            try {
                const { data: detailHtml } = await axios.get(detailUrl);
                const $$ = cheerio.load(detailHtml);

                let detailText = ($$('#sit_inf').text() + ' ' + $$('#sit_pvi').text() + ' ' + $$('#sit_tab').text() + ' ' + $$('#item_content').text() + ' ' + $$('.sit_info').text()).replace(/\s+/g, ' ');

                $$('#sit_inf img, #sit_pvi img, #sit_tab img, #item_content img, .sit_info img').each((i, el) => {
                    const src = $$(el).attr('src') || '';
                    const alt = $$(el).attr('alt') || '';
                    detailText += ' ' + src + ' ' + alt;
                });

                try { detailText = decodeURIComponent(detailText); } catch (e) { }

                item.performance = calculatePerformance(item.title, detailText, item.it_price);
                finalProducts.push(item);

                console.log(`  -> [딥 크롤링 성공] ID: ${item.it_id} | 분석 점수: ${item.performance}점 | 상품명: ${item.title.substring(0, 30)}...`);
            } catch (err) {
                console.error(`  -> [딥 크롤링 에러] ID: ${item.it_id} 로드 실패:`, err.message);
                item.performance = calculatePerformance(item.title, '', item.it_price);
                finalProducts.push(item);
            }

            await new Promise(r => setTimeout(r, 500));
        }

        console.log('\n-----------------------------');
        console.log(`[Crawler] 총 ${finalProducts.length}개 상품 Supabase pc_products 테이블에 Upsert 중...`);

        let successCount = 0;
        for (const product of finalProducts) {
            const { data: existing } = await supabase.from('pc_products').select('it_id').eq('it_id', product.it_id).maybeSingle();

            if (existing) {
                const { error } = await supabase.from('pc_products').update({
                    title: product.title,
                    it_price: product.it_price,
                    is_soldout: product.is_soldout,
                    performance: product.performance
                }).eq('it_id', product.it_id);
                if (!error) successCount++;
            } else {
                const { error } = await supabase.from('pc_products').insert([product]);
                if (!error) successCount++;
            }
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
