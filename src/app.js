const express = require('express');
const { supabase } = require('./db');
const { scrapeAndSync } = require('./crawler');

function createRecommendationApp(defaultPcId) {
    const app = express();

    app.get('/recommend', async (req, res) => {
        const { base, type } = req.query;

        if (!base) {
            return res.redirect(`/product/${defaultPcId}`);
        }

        // Fetch products from Supabase instead of parameters
        const { data: products, error } = await supabase
            .from('pc_products')
            .select('*');

        if (error || !products) {
            console.error('Error fetching products:', error);
            return res.redirect(`/product/${defaultPcId}`);
        }

        const baseProduct = products.find(p => p.it_id === base);
        if (!baseProduct) {
            return res.redirect(`/product/${defaultPcId}`);
        }

        const validTypes = ['value', 'alt', 'upgrade'];
        if (!type || !validTypes.includes(type)) {
            return res.redirect(`/product/${base}`);
        }

        const candidates = products.filter(p => {
            if (p.it_id.startsWith('57')) return false;
            if (p.is_soldout) return false;
            if (!p.it_id.startsWith('2')) return false;
            if (p.it_id === base) return false;
            return true;
        });

        let match = null;

        if (type === 'value') {
            const matches = candidates.filter(p =>
                p.it_price >= baseProduct.it_price * 0.85 &&
                p.it_price <= baseProduct.it_price * 0.95 &&
                p.performance >= baseProduct.performance * 0.90
            );
            if (matches.length > 0) {
                matches.sort((a, b) => a.it_price - b.it_price);
                match = matches[0];
            }
        } else if (type === 'alt') {
            const matches = candidates.filter(p =>
                p.performance >= baseProduct.performance * 0.95 &&
                p.performance <= baseProduct.performance * 1.05
            );
            if (matches.length > 0) {
                matches.sort((a, b) => {
                    const diffA = Math.abs(a.it_price - baseProduct.it_price);
                    const diffB = Math.abs(b.it_price - baseProduct.it_price);
                    return diffA - diffB;
                });
                match = matches[0];
            }
        } else if (type === 'upgrade') {
            const matches = candidates.filter(p =>
                p.performance > baseProduct.performance &&
                p.it_price >= baseProduct.it_price * 1.10 &&
                p.it_price <= baseProduct.it_price * 1.20
            );
            if (matches.length > 0) {
                matches.sort((a, b) => b.performance - a.performance);
                match = matches[0];
            }
        }

        if (!match) {
            return res.redirect(`/product/${base}`);
        }

        return res.redirect(`/product/${match.it_id}`);
    });

    app.get('/product/:id', (req, res) => {
        res.status(200).send(`Product Detail: ${req.params.id}`);
    });

    // Vercel Cron Crawler Trigger Endpoint
    app.get('/api/sync', async (req, res) => {
        const authHeader = req.headers.authorization;

        // 보안 처리: CRON_SECRET 토큰 검증
        if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        try {
            // Vercel Edge/Serverless 환경 제한 시간 내에 수행 (현재 상품 수 적으므로 처리 가능)
            await scrapeAndSync();
            return res.status(200).json({ success: true });
        } catch (error) {
            console.error('[API/Sync] Error:', error.message);
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    return app;
}

const app = createRecommendationApp('2772529981'); // 기본 Fallback ID 처리

// 로컬 환경 실행용
if (require.main === module) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Server is running locally on port ${port}`);
    });
}

// Vercel 환경에서는 반드시 Express app 객체를 직접 반환해야 작동합니다. (404 Not Found 방어)
module.exports = app;
// 기존 TDD 테스트 호환성 유지를 위한 명시적 export
module.exports.createRecommendationApp = createRecommendationApp;
