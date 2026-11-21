import { File } from 'expo-file-system';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Text,
  View,
  type ImageURISource,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SvgXml } from 'react-native-svg';
import { createSessionVisualRoles, useTokens } from '../theme';
import { LIGHT_COLORS } from '../theme/colors';

type Area = { width: number; height: number };

/**
 * Draw an SVG attachment with react-native-svg.
 *
 * The RN Image cannot decode SVG, and SvgUri cannot carry the app's
 * Authorization header, so the XML is read with the same source headers the
 * image path uses and drawn into a light box that keeps the document's aspect
 * ratio. A transparent-line SVG stays visible on the light background.
 */
export function AttachmentSvg({
  source,
  label,
  radius = 0,
  style,
  testID,
  onError,
}: {
  source: ImageURISource;
  label: string;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onError?(): void;
}) {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const uri = source.uri ?? '';
  const headersKey = JSON.stringify(Object.entries(source.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  const key = `${uri}\n${headersKey}`;
  const [loaded, setLoaded] = useState<{ key: string; xml?: string; failed: boolean }>({ key: '', failed: false });
  const current: { key: string; xml?: string; failed: boolean } = loaded.key === key ? loaded : { key, failed: false };
  const [area, setArea] = useState<Area | null>(null);
  // The viewer lifts a read failure to its own failure cover; the tile passes no handler.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!uri) {
      setLoaded({ key, failed: true });
      onErrorRef.current?.();
      return;
    }
    let active = true;
    const controller = new AbortController();
    void readSvgXml(uri, source.headers, controller.signal)
      .then((xml) => {
        if (!active) return;
        const drawing = /<svg[\s>]/i.test(xml) ? xml : undefined;
        setLoaded({ key, ...(drawing ? { xml: drawing } : {}), failed: !drawing });
        if (!drawing) onErrorRef.current?.();
      })
      .catch(() => {
        if (active) {
          setLoaded({ key, failed: true });
          onErrorRef.current?.();
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, uri]);

  const ratio = current.xml ? svgAspectRatio(current.xml) : null;
  const box = area ? fitSvgBox(area, ratio) : null;
  const updateArea = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.width > 0 && layout.height > 0) {
      setArea((previous) => previous && previous.width === layout.width && previous.height === layout.height
        ? previous : { width: layout.width, height: layout.height });
    }
  };
  return <View
    testID={testID}
    accessible
    accessibilityLabel={label}
    onLayout={updateArea}
    style={[{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }, style]}
  >
    {current.failed
      ? <Text style={{ ...attachment.metadata, color: attachment.textMuted, textAlign: 'center' }}>불러오지 못함</Text>
      : current.xml && box
        ? <View style={{
          width: box.width,
          height: box.height,
          borderRadius: radius,
          overflow: 'hidden',
          backgroundColor: LIGHT_COLORS.background,
        }}>
          <SvgXml
            xml={current.xml}
            width={box.width}
            height={box.height}
            onError={() => {
              setLoaded({ key, failed: true });
              onErrorRef.current?.();
            }}
            fallback={<View style={{ width: box.width, height: box.height, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ ...attachment.metadata, color: attachment.textMuted, textAlign: 'center' }}>불러오지 못함</Text>
            </View>}
          />
        </View>
        : <ActivityIndicator size="small" color={t.colors.accent} />}
  </View>;
}

async function readSvgXml(uri: string, headers: ImageURISource['headers'], signal: AbortSignal): Promise<string> {
  if (/^file:/i.test(uri)) return new File(uri).text();
  const response = await fetch(uri, { ...(headers ? { headers } : {}), signal });
  if (!response.ok) throw new Error(`svg read failed: ${response.status}`);
  return response.text();
}

/** Aspect ratio of the outermost svg element, from viewBox or width/height. */
export function svgAspectRatio(xml: string): number | null {
  const viewBox = /<svg\b[^>]*\bviewBox\s*=\s*["']\s*([^"']+)["']/i.exec(xml);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return parts[2] / parts[3];
  }
  const width = /<svg\b[^>]*\bwidth\s*=\s*["']\s*([\d.]+)/i.exec(xml)?.[1];
  const height = /<svg\b[^>]*\bheight\s*=\s*["']\s*([\d.]+)/i.exec(xml)?.[1];
  const parsedWidth = width === undefined ? NaN : Number(width);
  const parsedHeight = height === undefined ? NaN : Number(height);
  return parsedWidth > 0 && parsedHeight > 0 ? parsedWidth / parsedHeight : null;
}

/** Largest width/height pair with the given ratio that fits the area. */
export function fitSvgBox(area: Area, ratio: number | null): Area {
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0 || area.width <= 0 || area.height <= 0) {
    return { width: Math.max(0, Math.floor(area.width)), height: Math.max(0, Math.floor(area.height)) };
  }
  return area.width / area.height > ratio
    ? { width: Math.max(0, Math.floor(area.height * ratio)), height: Math.floor(area.height) }
    : { width: Math.floor(area.width), height: Math.max(0, Math.floor(area.width / ratio)) };
}
