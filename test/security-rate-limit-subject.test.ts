import { describe, expect, it } from 'vitest';
import { rateLimitSubject } from '../src/lib/security';

describe('rateLimitSubject', () => {
	it('leaves IPv4 alone', () => {
		expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7');
	});

	it('reduces IPv6 to its /64, whatever the spelling', () => {
		const a = rateLimitSubject('2001:db8:1:2::1');
		expect(a).toBe('2001:db8:1:2::/64');
		expect(rateLimitSubject('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe(a);
		expect(rateLimitSubject('2001:DB8:1:2:FFFF::9')).toBe(a);
		expect(rateLimitSubject('[2001:db8:1:2::abcd]')).toBe(a);
		expect(rateLimitSubject('2001:db8:1:2::1%eth0')).toBe(a);
	});

	it('keeps different /64s apart', () => {
		expect(rateLimitSubject('2001:db8:1:3::1')).not.toBe(rateLimitSubject('2001:db8:1:2::1'));
		expect(rateLimitSubject('2001:db8::1')).toBe('2001:db8:0:0::/64');
		expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64');
	});

	it('unwraps IPv4-mapped IPv6', () => {
		expect(rateLimitSubject('::ffff:1.2.3.4')).toBe('1.2.3.4');
		expect(rateLimitSubject('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4');
	});

	it('passes garbage through unchanged', () => {
		for (const junk of ['not-an-ip', '1::2::3', '2001:db8:zz::1', '1:2:3:4:5:6:7:8:9', '']) {
			expect(rateLimitSubject(junk)).toBe(junk);
		}
	});
});
