jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { CardBoard } from '../CardBoard';
import { cardFixture } from '../../../test-support/cards';
import { boardLaneGeometry, boardLaneOffset, boardVisibleColumns } from '../../../lib/card-board-layout';

test('opening a different board geometry restores the named lane instead of the old x', () => {
  const saved = jest.fn();
  const screen = render(<CardBoard phone={false} api={null} cards={[]} includeCompleted={false}
    initialPosition={{ x: 9999, lane: 'running', lanes: {} }} onOpen={() => {}} onPositionChange={saved} />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 800, height: 600 } } });
  const columns = boardVisibleColumns(false);
  const geometry = boardLaneGeometry(800, 320 * 0.8 * 15 / 17, 8, false, columns, 8 * 15 / 17);
  expect(saved.mock.calls.at(-1)[0].lane).toBe('running');
  expect(saved.mock.calls.at(-1)[0].x).toBe(boardLaneOffset(2, 800, geometry, columns.length));
});

test('phone initially shows review even empty, snaps by lane and preserves position across rerenders', () => {
  const saved = jest.fn();
  const screen = render(<CardBoard phone api={null} cards={[]} onOpen={() => {}} onPositionChange={saved} />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
  const board = screen.getByTestId('card-board');
  expect(board.props.snapToOffsets[0]).toBe(0);
  expect(saved.mock.calls.at(-1)[0].x).toBe(board.props.snapToOffsets[4]);
  expect(screen.getByTestId('card-board-lane-heading-review').props.children).toEqual(expect.arrayContaining(['검수 대기 ', expect.anything()]));
  expect(StyleSheet.flatten(screen.getByTestId('card-board-column-review').props.style).width).toBeLessThan(390);
  fireEvent.scroll(board, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  screen.rerender(<CardBoard phone api={null} cards={[cardFixture()]} onOpen={() => {}} />);
  expect(screen.getByTestId('card-board').props.contentOffset.x).toBe(board.props.contentOffset.x);
  const paper = screen.getByTestId('postit-card-card-1').props.style;
  expect(paper.width / paper.height).toBeCloseTo(320 / 280);
  expect(paper.width).toBeLessThan(StyleSheet.flatten(screen.getByTestId('card-board-column-todo').props.style).width);
});

test('숨김 토글은 중간 선택 레인을 유지하고 완료 선택만 검수 대기로 되돌린다', () => {
  const saved = jest.fn();
  const screen = render(<CardBoard phone api={null} cards={[]} includeCompleted onOpen={() => {}} onPositionChange={saved} />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 390, height: 600 } } });
  fireEvent.scroll(screen.getByTestId('card-board'), { nativeEvent: { contentOffset: { x: screen.getByTestId('card-board').props.snapToOffsets[2], y: 0 } } });
  screen.rerender(<CardBoard phone api={null} cards={[]} includeCompleted={false} onOpen={() => {}} onPositionChange={saved} />);
  expect(saved.mock.calls.at(-1)[0].lane).toBe('running');
  expect(screen.queryByLabelText('완료 레인 보기')).toBeNull();
  screen.rerender(<CardBoard phone api={null} cards={[]} includeCompleted onOpen={() => {}} onPositionChange={saved} />);
  fireEvent.scroll(screen.getByTestId('card-board'), { nativeEvent: { contentOffset: { x: screen.getByTestId('card-board').props.snapToOffsets[5], y: 0 } } });
  screen.rerender(<CardBoard phone api={null} cards={[]} includeCompleted={false} onOpen={() => {}} onPositionChange={saved} />);
  expect(saved.mock.calls.at(-1)[0].lane).toBe('review');
  expect(saved.mock.calls.at(-1)[0].x).toBe(screen.getByTestId('card-board').props.snapToOffsets[4]);
});

 test('pointer mouse pan changes horizontal position before longpress, vertical motion and secondary click do not', () => {
  const saved=jest.fn(),open=jest.fn();
  const screen=render(<CardBoard phone={false} api={null} cards={[cardFixture()]} onOpen={open} onPositionChange={saved} />);
  const frame=screen.getByTestId('card-board-frame');
  fireEvent(frame,'layout',{nativeEvent:{layout:{width:600,height:500}}});
  fireEvent(frame,'pointerDown',{nativeEvent:{pointerType:'mouse',button:0,pointerId:1,pageX:500,pageY:80}});
  fireEvent(frame,'pointerMove',{preventDefault:jest.fn(),nativeEvent:{pointerType:'mouse',pointerId:1,pageX:400,pageY:82}});
  fireEvent(frame,'pointerUp',{nativeEvent:{pointerId:1}});
  expect(saved.mock.calls.at(-1)[0].x).toBe(100);
  fireEvent.press(screen.getByLabelText('카드 제목 카드 상세'));
  expect(open).not.toHaveBeenCalled();
  fireEvent(frame,'pointerDown',{nativeEvent:{pointerType:'mouse',button:0,pointerId:2,pageX:400,pageY:80}});
  fireEvent(frame,'pointerMove',{preventDefault:jest.fn(),nativeEvent:{pointerType:'mouse',pointerId:2,pageX:395,pageY:160}});
  expect(saved.mock.calls.at(-1)[0].x).toBe(100);
 });

test.each([true, false])('phone=%s has no status tabs and the empty draft heading owns creation', phone => {
  const create = jest.fn();
  const screen = render(<CardBoard phone={phone} api={null} cards={[]} includeCompleted={false} onOpen={() => {}} onCreate={create} />);
  expect(screen.queryByTestId('card-board-stages')).toBeNull();
  const draft = require('@testing-library/react-native').within(screen.getByTestId('card-board-column-todo'));
  expect(draft.getByText(/드래프트/)).toBeTruthy();
  expect(draft.getByTestId('card-board-count-todo').props.children).toBe('0개');
  fireEvent.press(draft.getByLabelText('드래프트 카드 추가'));
  expect(create).toHaveBeenCalledTimes(1);
});


test('취소 레인도 숨길 때 검수 대기로 돌아오고 펼친 보드에서 취소 위치를 복원한다',()=>{
 const saved=jest.fn();const props={phone:true,api:null,cards:[],onOpen:()=>{},onPositionChange:saved};
 const screen=render(<CardBoard {...props} includeCompleted initialPosition={{x:0,lane:'cancelled',lanes:{}}}/>);
 fireEvent(screen.getByTestId('card-board-frame'),'layout',{nativeEvent:{layout:{width:390,height:600}}});
 expect(saved.mock.calls.at(-1)[0].lane).toBe('cancelled');
 screen.rerender(<CardBoard {...props} includeCompleted={false}/>);
 expect(saved.mock.calls.at(-1)[0].lane).toBe('review');
});
