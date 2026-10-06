jest.mock('../useSwayCharacterAnimation', () => ({ useSwayCharacterAnimation: jest.fn(() => ({ phase: { value: 0 } })) }));
import React from 'react';
import { Image } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SwayCharacter } from '../SwayCharacter';
import { useSwayCharacterAnimation } from '../useSwayCharacterAnimation';

test('정지 이미지 실패 뒤 자리는 부모에 남기고 움직임 shown 게이트를 닫는다', () => {
  const screen = render(<SwayCharacter width={152} height={228} shown motionEnabled active />);
  expect(jest.mocked(useSwayCharacterAnimation).mock.calls.at(-1)![0]).toMatchObject({ shown: true });
  fireEvent(screen.UNSAFE_getByType(Image), 'error', { nativeEvent: { error: '이미지 읽기 실패' } });
  expect(screen.toJSON()).toBeNull();
  expect(jest.mocked(useSwayCharacterAnimation).mock.calls.at(-1)![0]).toMatchObject({ shown: false });
});
