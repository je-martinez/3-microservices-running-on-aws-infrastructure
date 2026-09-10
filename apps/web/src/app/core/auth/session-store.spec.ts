import { TestBed } from '@angular/core/testing';

import { User } from '../api/types';
import { SessionStore } from './session-store';

const USER = {
  id: 'user-1',
  email: 'jane@example.com',
  fullName: 'Jane Doe',
} as unknown as User;

function store(): InstanceType<typeof SessionStore> {
  TestBed.configureTestingModule({});
  return TestBed.inject(SessionStore);
}

describe('SessionStore', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('starts signed out', () => {
    const session = store();

    expect(session.user()).toBeNull();
    expect(session.isAuthenticated()).toBe(false);
  });

  it('holds the user and derives isAuthenticated from it', () => {
    const session = store();

    session.setUser(USER);

    expect(session.user()).toEqual(USER);
    expect(session.isAuthenticated()).toBe(true);
  });

  it('drops the user on clear', () => {
    const session = store();
    session.setUser(USER);

    session.clear();

    expect(session.user()).toBeNull();
    expect(session.isAuthenticated()).toBe(false);
  });
});
