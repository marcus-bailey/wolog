import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, Refused, request } from './api';
import { browser } from './session';

function respond(status: number, body?: unknown) {
  const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const init = { status, headers };
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), init));
}

describe('request', () => {
  let leave: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    leave = vi.spyOn(browser, 'leave').mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('calls the API under the base path', async () => {
    const fetch = respond(200, []);
    vi.stubGlobal('fetch', fetch);
    await request('GET', 'exercises');
    expect(API_BASE).toBe('/wolog/api/');
    expect(fetch).toHaveBeenCalledWith('/wolog/api/exercises', expect.objectContaining({ method: 'GET' }));
  });

  it('on 401 goes to sign in and never settles', async () => {
    vi.stubGlobal('fetch', respond(401));
    const settled = vi.fn();
    void request('GET', 'exercises').then(settled, settled);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
    expect(leave.mock.calls[0]?.[0]).toMatch(/^\/oauth2\/start\?rd=/);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).not.toHaveBeenCalled();
  });

  it('on 401 after the loop guard trips, says so instead of leaving', async () => {
    vi.stubGlobal('fetch', respond(401));
    for (let i = 0; i < 3; i++) void request('GET', 'exercises');
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(3));
    await expect(request('GET', 'exercises')).rejects.toThrow(/signed out/);
    expect(leave).toHaveBeenCalledTimes(3);
  });

  it('turns a refusal into Refused with its message', async () => {
    vi.stubGlobal('fetch', respond(409, { code: 'name_taken', message: 'Taken.' }));
    const error = await request('POST', 'exercises', { name: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Refused);
    expect(error).toMatchObject({ code: 'name_taken', message: 'Taken.' });
  });

  it('reports other failures plainly', async () => {
    vi.stubGlobal('fetch', respond(500));
    await expect(request('GET', 'exercises')).rejects.toThrow('Something went wrong (HTTP 500). Try again.');
  });
});
