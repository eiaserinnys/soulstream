import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(srcRoot, relativePath), 'utf8');

describe('SessionCard production consumer closure', () => {
  test('피드·검색·최근 본 세션·업무 실행 이력은 같은 SessionCard 정본을 소비한다', () => {
    const byId = read('components/SessionCardById.tsx');
    const feed = read('screens/SessionFeedScreen.tsx');
    const search = read('screens/SearchScreen.tsx');
    const recent = read('screens/SearchScreenSupport.tsx');
    const history = read('components/planner/FolderSessionHistory.tsx');

    expect(byId).toContain("import { SessionCard } from './SessionCard';");
    expect(byId).toContain('<SessionCard');
    expect(feed).toContain("import { SessionCardById } from '../components/SessionCardById';");
    expect(feed).toContain('<SessionCardById');
    expect(search).toContain("import { SessionCardById } from '../components/SessionCardById';");
    expect(search).toContain('<SessionCardById');
    expect(recent).toContain("import { SessionCardById } from '../components/SessionCardById';");
    expect(recent).toContain('<SessionCardById');
    expect(history).toContain("import { SessionCard } from '../SessionCard';");
    expect(history).toContain('<SessionCard');
  });

  test('production source에는 SessionCard 대체 구현이 없다', () => {
    const productionFiles = fs.readdirSync(srcRoot, { recursive: true })
      .map(String)
      .filter((file) => /\.(tsx|ts)$/.test(file))
      .filter((file) => !file.includes('__tests__'));
    const definitions = productionFiles.filter((file) =>
      /function\s+SessionCard\s*\(/.test(read(file)),
    );
    expect(definitions).toEqual(['components/SessionCard.tsx']);
  });
});
