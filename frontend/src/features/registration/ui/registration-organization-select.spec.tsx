// src/features/registration/ui/registration-organization-select.spec.tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../infrastructure/registration-organization-adapter', () => ({
  fetchRegistrationOrganizations: fetchMock,
}));

import type { RegistrationOrganizationPage } from '../application/registration.types';

import { RegistrationOrganizationSelect } from './registration-organization-select';

function pageOf(
  page: number,
  pageSize: number,
  total: number,
  items: RegistrationOrganizationPage['items'],
): RegistrationOrganizationPage {
  return { items, page, pageSize, total };
}

async function getCombobox(): Promise<HTMLElement> {
  return screen.findByRole('combobox', { name: '所属公司' });
}

describe('RegistrationOrganizationSelect（注册公司共用选择器）', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('加载候选后可键盘选择，并只回传 id 与名称', async () => {
    fetchMock.mockResolvedValue(
      pageOf(1, 20, 2, [
        { id: 11, name: '公司A' },
        { id: 12, name: '公司B' },
      ]),
    );
    const onChange = vi.fn();

    render(<RegistrationOrganizationSelect ariaLabel="所属公司" onChange={onChange} />);

    const combobox = await getCombobox();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(combobox);
    await screen.findByText('公司A');

    // 打开后第一项默认高亮；方向键下移一项后回车选择
    fireEvent.keyDown(combobox, { key: 'ArrowDown', keyCode: 40 });
    fireEvent.keyDown(combobox, { key: 'Enter', keyCode: 13 });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: 12, name: '公司B' }));
  });

  it('空名单显示可理解的空状态文案', async () => {
    fetchMock.mockResolvedValue(pageOf(1, 20, 0, []));

    render(<RegistrationOrganizationSelect ariaLabel="所属公司" />);

    const combobox = await getCombobox();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(combobox);
    expect(await screen.findByText('未找到符合条件的公司')).toBeInTheDocument();
  });

  it('加载失败展示重试入口，点击后重新请求', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(pageOf(1, 20, 1, [{ id: 21, name: '公司C' }]));

    render(<RegistrationOrganizationSelect ariaLabel="所属公司" />);

    const retry = await screen.findByRole('button', { name: /重试/ });
    fireEvent.click(retry);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.mouseDown(await getCombobox());
    expect(await screen.findByText('公司C')).toBeInTheDocument();
  });

  it('输入关键字触发公开检索', async () => {
    fetchMock.mockResolvedValue(pageOf(1, 20, 0, []));

    render(<RegistrationOrganizationSelect ariaLabel="所属公司" />);

    const combobox = await getCombobox();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(combobox, { target: { value: '光刻' } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        keyword: '光刻',
        page: 1,
        pageSize: 20,
      }),
    );
  });

  it('存在下一页时可通过「加载更多」追加候选', async () => {
    fetchMock
      .mockResolvedValueOnce(pageOf(1, 20, 2, [{ id: 31, name: '公司D' }]))
      .mockResolvedValueOnce(pageOf(2, 20, 2, [{ id: 32, name: '公司E' }]));

    render(<RegistrationOrganizationSelect ariaLabel="所属公司" />);

    const loadMore = await screen.findByRole('button', { name: '加载更多' });
    fireEvent.click(loadMore);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        keyword: undefined,
        page: 2,
        pageSize: 20,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument(),
    );
  });

  it('追加失败时只保留重试入口，不再重复展示「加载更多」', async () => {
    fetchMock
      .mockResolvedValueOnce(pageOf(1, 20, 2, [{ id: 41, name: '公司F' }]))
      .mockRejectedValueOnce(new Error('network down'));

    render(<RegistrationOrganizationSelect ariaLabel="所属公司" />);

    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));

    expect(await screen.findByRole('button', { name: '加载更多失败，重试' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  });
});
