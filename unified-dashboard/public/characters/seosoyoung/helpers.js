const core=globalThis.SeosoyoungMotionCore;
  function normalizeExpressionManifest(source) {
    if (source?.version !== 1 || !Array.isArray(source.expressions)) {
      throw new Error('표정 기록 형식이 올바르지 않습니다.');
    }
    const expectedIds = new Set(['angry', 'teary', 'surprised', 'happy', 'embarrassed']);
    const seen = new Set();
    const normalized = source.expressions.map((record) => {
      if (!expectedIds.has(record.id) || seen.has(record.id)) {
        throw new Error(`표정 ID가 올바르지 않습니다: ${record.id}`);
      }
      seen.add(record.id);
      ['eyes', 'mouth'].forEach((kind) => {
        const asset = record[kind];
        if (!asset?.src || asset.nativeSize?.width !== 1280 || asset.nativeSize?.height !== 768) {
          throw new Error(`${record.id}.${kind} 소재 크기가 올바르지 않습니다.`);
        }
        core.assertBounds(asset.stageBounds, `${record.id}.${kind}.stageBounds`);
      });
      ['left', 'right'].forEach((side) => {
        const pose = record.browPose?.[side];
        const values = pose ? [...(pose.pivot || []), pose.dx, pose.dy, pose.rotationDegrees] : [];
        if (values.length !== 5 || values.some((value) => !Number.isFinite(value))) {
          throw new Error(`${record.id}.${side} 눈썹 포즈가 올바르지 않습니다.`);
        }
      });
      return {
        ...record,
        eyes: { ...record.eyes, imageId: `expression:${record.id}:eyes` },
        mouth: { ...record.mouth, imageId: `expression:${record.id}:mouth` },
      };
    });
    if (seen.size !== expectedIds.size) throw new Error('다섯 가지 표정 기록이 모두 필요합니다.');
    return normalized;
  }


  function createPartTree(manifest, clothingSet) {
    const leaves = new Map(manifest.leaves.map((leaf) => [leaf.id, leaf]));
    const leafNode = (id, fallbackLabel = id) => ({ id, label: leaves.get(id)?.label || fallbackLabel });
    const eyeMotion = manifest.motion.eyes;
    return manifest.parents.map((parent) => {
      if (parent.id === 'body-neck') {
        return {
          id: parent.id,
          label: '몸과 의상',
          children: clothingSet.map((part) => ({ id: part.id, label: part.label || part.id })),
        };
      }
      if (parent.id === 'eyes-brows') {
        return {
          id: parent.id,
          label: parent.label,
          children: [
            { id: 'eyes', label: '눈', children: eyeMotion.openLeafIds.map((id) => leafNode(id)) },
            { id: 'brows', label: '눈썹', children: eyeMotion.browLeafIds.map((id) => leafNode(id)) },
          ],
        };
      }
      return { id: parent.id, label: parent.label, children: parent.leafIds.map((id) => leafNode(id)) };
    });
  }


  function normalizeClothingManifest(source) {
    if (source?.version !== 1 || !Array.isArray(source.parts)) {
      throw new Error('의상 기록 형식이 올바르지 않습니다.');
    }
    const expectedIds = new Set(['upper-body-short-sleeve', 'necklace', 'sweater', 'skirt']);
    const seen = new Set();
    const normalized = source.parts.map((part) => {
      if (!expectedIds.has(part.id) || seen.has(part.id)) throw new Error(`의상 ID가 올바르지 않습니다: ${part.id}`);
      seen.add(part.id);
      const bounds = core.assertBounds(part.stageBounds, `${part.id}.stageBounds`);
      if (!part.src || part.nativeSize?.width !== 1024 || part.nativeSize?.height !== 960
        || bounds.x !== 0 || bounds.y !== 576 || bounds.width !== 1024 || bounds.height !== 960) {
        throw new Error(`${part.id} 소재 크기나 배치가 올바르지 않습니다.`);
      }
      return { ...part, imageId: `clothing:${part.id}` };
    });
    if (seen.size !== expectedIds.size) throw new Error('네 가지 의상 기록이 모두 필요합니다.');
    return normalized;
  }

