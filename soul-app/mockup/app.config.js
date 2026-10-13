const baseUrl = process.env.MOCKUP_BASE_URL;
if (!baseUrl || !/^\/d\/[a-zA-Z0-9_-]+$/.test(baseUrl)) {
  throw new Error('MOCKUP_BASE_URL은 끝 슬래시 없는 /d/<slug> 경로여야 합니다.');
}

module.exports = {
  expo: {
    name: 'Soulstream 앱 시안',
    slug: 'soul-app-mockup',
    web: { bundler: 'metro', output: 'single' },
    experiments: { baseUrl },
  },
};
