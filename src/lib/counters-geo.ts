// OWNER: realtime agent.
// Turning country codes into flags and Cloudflare colo codes into places, for /stats.

/** Regional-indicator flag for an ISO 3166-1 alpha-2 code. Tor gets an onion; unknowns get a white flag. */
export function flagEmoji(code: string): string {
	const upper = code.trim().toUpperCase();
	if (upper === 'T1') return '🧅';
	if (!/^[A-Z]{2}$/.test(upper) || upper === 'XX') return '🏳️';
	return String.fromCodePoint(...[...upper].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let regionNames: Intl.DisplayNames | null | undefined;

/** English (UK) name for a country code, e.g. 'GB' → 'United Kingdom'. */
export function countryName(code: string): string {
	const upper = code.trim().toUpperCase();
	if (upper === 'T1') return 'Tor (location: yes)';
	if (upper === 'XX' || !/^[A-Z]{2}$/.test(upper)) return 'Parts unknown';
	if (regionNames === undefined) {
		try {
			regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region', fallback: 'code' });
		} catch {
			regionNames = null;
		}
	}
	try {
		return regionNames?.of(upper) ?? upper;
	} catch {
		return upper;
	}
}

/**
 * Common Cloudflare datacentres by IATA code: [city, ISO country]. Not
 * exhaustive (there are 300-odd); unknown codes are shown as the bare code.
 */
export const COLO_CITIES: Readonly<Record<string, readonly [city: string, country: string]>> = {
	// Britain & Ireland
	LHR: ['London', 'GB'],
	MAN: ['Manchester', 'GB'],
	EDI: ['Edinburgh', 'GB'],
	DUB: ['Dublin', 'IE'],
	ORK: ['Cork', 'IE'],
	// Rest of Europe
	AMS: ['Amsterdam', 'NL'],
	BRU: ['Brussels', 'BE'],
	LUX: ['Luxembourg', 'LU'],
	CDG: ['Paris', 'FR'],
	MRS: ['Marseille', 'FR'],
	LYS: ['Lyon', 'FR'],
	FRA: ['Frankfurt', 'DE'],
	DUS: ['Düsseldorf', 'DE'],
	HAM: ['Hamburg', 'DE'],
	MUC: ['Munich', 'DE'],
	BER: ['Berlin', 'DE'],
	TXL: ['Berlin', 'DE'],
	STR: ['Stuttgart', 'DE'],
	ZRH: ['Zürich', 'CH'],
	GVA: ['Geneva', 'CH'],
	VIE: ['Vienna', 'AT'],
	PRG: ['Prague', 'CZ'],
	WAW: ['Warsaw', 'PL'],
	BUD: ['Budapest', 'HU'],
	OTP: ['Bucharest', 'RO'],
	SOF: ['Sofia', 'BG'],
	BEG: ['Belgrade', 'RS'],
	ZAG: ['Zagreb', 'HR'],
	ATH: ['Athens', 'GR'],
	IST: ['Istanbul', 'TR'],
	MAD: ['Madrid', 'ES'],
	BCN: ['Barcelona', 'ES'],
	LIS: ['Lisbon', 'PT'],
	MXP: ['Milan', 'IT'],
	FCO: ['Rome', 'IT'],
	PMO: ['Palermo', 'IT'],
	CPH: ['Copenhagen', 'DK'],
	ARN: ['Stockholm', 'SE'],
	OSL: ['Oslo', 'NO'],
	HEL: ['Helsinki', 'FI'],
	RIX: ['Riga', 'LV'],
	TLL: ['Tallinn', 'EE'],
	VNO: ['Vilnius', 'LT'],
	KBP: ['Kyiv', 'UA'],
	// North America
	EWR: ['Newark', 'US'],
	IAD: ['Ashburn', 'US'],
	BOS: ['Boston', 'US'],
	PHL: ['Philadelphia', 'US'],
	ATL: ['Atlanta', 'US'],
	MIA: ['Miami', 'US'],
	CLT: ['Charlotte', 'US'],
	ORD: ['Chicago', 'US'],
	DTW: ['Detroit', 'US'],
	MSP: ['Minneapolis', 'US'],
	MCI: ['Kansas City', 'US'],
	STL: ['St Louis', 'US'],
	DFW: ['Dallas', 'US'],
	IAH: ['Houston', 'US'],
	DEN: ['Denver', 'US'],
	PHX: ['Phoenix', 'US'],
	SLC: ['Salt Lake City', 'US'],
	LAS: ['Las Vegas', 'US'],
	LAX: ['Los Angeles', 'US'],
	SJC: ['San José', 'US'],
	SFO: ['San Francisco', 'US'],
	SEA: ['Seattle', 'US'],
	PDX: ['Portland', 'US'],
	HNL: ['Honolulu', 'US'],
	YYZ: ['Toronto', 'CA'],
	YUL: ['Montréal', 'CA'],
	YVR: ['Vancouver', 'CA'],
	YYC: ['Calgary', 'CA'],
	MEX: ['Mexico City', 'MX'],
	QRO: ['Querétaro', 'MX'],
	// South America
	GRU: ['São Paulo', 'BR'],
	GIG: ['Rio de Janeiro', 'BR'],
	EZE: ['Buenos Aires', 'AR'],
	SCL: ['Santiago', 'CL'],
	BOG: ['Bogotá', 'CO'],
	LIM: ['Lima', 'PE'],
	// Africa & Middle East
	JNB: ['Johannesburg', 'ZA'],
	CPT: ['Cape Town', 'ZA'],
	LOS: ['Lagos', 'NG'],
	NBO: ['Nairobi', 'KE'],
	CAI: ['Cairo', 'EG'],
	DXB: ['Dubai', 'AE'],
	DOH: ['Doha', 'QA'],
	RUH: ['Riyadh', 'SA'],
	AMM: ['Amman', 'JO'],
	TLV: ['Tel Aviv', 'IL'],
	// Asia & Oceania
	BOM: ['Mumbai', 'IN'],
	DEL: ['New Delhi', 'IN'],
	MAA: ['Chennai', 'IN'],
	BLR: ['Bengaluru', 'IN'],
	HYD: ['Hyderabad', 'IN'],
	SIN: ['Singapore', 'SG'],
	HKG: ['Hong Kong', 'HK'],
	NRT: ['Tokyo', 'JP'],
	KIX: ['Osaka', 'JP'],
	ICN: ['Seoul', 'KR'],
	TPE: ['Taipei', 'TW'],
	BKK: ['Bangkok', 'TH'],
	KUL: ['Kuala Lumpur', 'MY'],
	CGK: ['Jakarta', 'ID'],
	MNL: ['Manila', 'PH'],
	SGN: ['Ho Chi Minh City', 'VN'],
	HAN: ['Hanoi', 'VN'],
	SYD: ['Sydney', 'AU'],
	MEL: ['Melbourne', 'AU'],
	BNE: ['Brisbane', 'AU'],
	PER: ['Perth', 'AU'],
	ADL: ['Adelaide', 'AU'],
	AKL: ['Auckland', 'NZ'],
};

export interface ColoInfo {
	/** Upper-case IATA code (or 'XXX'). */
	code: string;
	/** City, if we know it. */
	city: string | null;
	/** ISO country of the city, if we know it. */
	country: string | null;
	/** Human label: "London", or a shrug for codes we don't know. */
	label: string;
}

/** City + country for a Cloudflare colo code. */
export function coloInfo(code: string | null | undefined): ColoInfo {
	const upper = (code ?? '').trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(upper) || upper === 'XXX') {
		return { code: 'XXX', city: null, country: null, label: 'an undisclosed datacentre' };
	}
	const known = COLO_CITIES[upper];
	if (known) return { code: upper, city: known[0], country: known[1], label: known[0] };
	return { code: upper, city: null, country: null, label: `somewhere with a runway called ${upper}` };
}
