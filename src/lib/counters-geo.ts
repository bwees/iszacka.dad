// OWNER: realtime agent.
// Turning country codes into flags and Cloudflare colo codes into places, for /stats.

/** Regional-indicator flag for an ISO 3166-1 alpha-2 code. Tor gets an onion; unknowns get a white flag. */
export function flagEmoji(code: string): string {
	const upper = code.trim().toUpperCase();
	if (upper === 'T1') return '🧅';
	if (!/^[A-Z]{2}$/.test(upper) || upper === 'XX') return '🏳️';
	return String.fromCodePoint(...[...upper].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/**
 * English (UK) region names, one "CODE Name" per line: exactly what workerd's
 * `new Intl.DisplayNames(['en-GB'], { type: 'region' })` says (generated from it, ICU 77).
 * A table rather than Intl because the first Intl call in a fresh isolate costs workerd
 * several milliseconds of CPU, and most requests here land in a fresh isolate.
 */
const REGION_NAMES = `
AC Ascension Island
AD Andorra
AE United Arab Emirates
AF Afghanistan
AG Antigua & Barbuda
AI Anguilla
AL Albania
AM Armenia
AN Curaçao
AO Angola
AQ Antarctica
AR Argentina
AS American Samoa
AT Austria
AU Australia
AW Aruba
AX Åland Islands
AZ Azerbaijan
BA Bosnia & Herzegovina
BB Barbados
BD Bangladesh
BE Belgium
BF Burkina Faso
BG Bulgaria
BH Bahrain
BI Burundi
BJ Benin
BL St Barthélemy
BM Bermuda
BN Brunei
BO Bolivia
BQ Caribbean Netherlands
BR Brazil
BS Bahamas
BT Bhutan
BU Myanmar (Burma)
BV Bouvet Island
BW Botswana
BY Belarus
BZ Belize
CA Canada
CC Cocos (Keeling) Islands
CD Congo - Kinshasa
CF Central African Republic
CG Congo - Brazzaville
CH Switzerland
CI Côte d’Ivoire
CK Cook Islands
CL Chile
CM Cameroon
CN China
CO Colombia
CP Clipperton Island
CQ Sark
CR Costa Rica
CS Serbia
CU Cuba
CV Cape Verde
CW Curaçao
CX Christmas Island
CY Cyprus
CZ Czechia
DD Germany
DE Germany
DG Diego Garcia
DJ Djibouti
DK Denmark
DM Dominica
DO Dominican Republic
DY Benin
DZ Algeria
EA Ceuta & Melilla
EC Ecuador
EE Estonia
EG Egypt
EH Western Sahara
ER Eritrea
ES Spain
ET Ethiopia
EU European Union
EZ Eurozone
FI Finland
FJ Fiji
FK Falkland Islands (Islas Malvinas)
FM Micronesia
FO Faroe Islands
FR France
FX France
GA Gabon
GB United Kingdom
GD Grenada
GE Georgia
GF French Guiana
GG Guernsey
GH Ghana
GI Gibraltar
GL Greenland
GM Gambia
GN Guinea
GP Guadeloupe
GQ Equatorial Guinea
GR Greece
GS South Georgia & South Sandwich Islands
GT Guatemala
GU Guam
GW Guinea-Bissau
GY Guyana
HK Hong Kong
HM Heard & McDonald Islands
HN Honduras
HR Croatia
HT Haiti
HU Hungary
HV Burkina Faso
IC Canary Islands
ID Indonesia
IE Ireland
IL Israel
IM Isle of Man
IN India
IO British Indian Ocean Territory
IQ Iraq
IR Iran
IS Iceland
IT Italy
JE Jersey
JM Jamaica
JO Jordan
JP Japan
KE Kenya
KG Kyrgyzstan
KH Cambodia
KI Kiribati
KM Comoros
KN St Kitts & Nevis
KP North Korea
KR South Korea
KW Kuwait
KY Cayman Islands
KZ Kazakhstan
LA Laos
LB Lebanon
LC St Lucia
LI Liechtenstein
LK Sri Lanka
LR Liberia
LS Lesotho
LT Lithuania
LU Luxembourg
LV Latvia
LY Libya
MA Morocco
MC Monaco
MD Moldova
ME Montenegro
MF St Martin
MG Madagascar
MH Marshall Islands
MK North Macedonia
ML Mali
MM Myanmar (Burma)
MN Mongolia
MO Macao
MP Northern Mariana Islands
MQ Martinique
MR Mauritania
MS Montserrat
MT Malta
MU Mauritius
MV Maldives
MW Malawi
MX Mexico
MY Malaysia
MZ Mozambique
NA Namibia
NC New Caledonia
NE Niger
NF Norfolk Island
NG Nigeria
NH Vanuatu
NI Nicaragua
NL Netherlands
NO Norway
NP Nepal
NR Nauru
NU Niue
NZ New Zealand
OM Oman
PA Panama
PE Peru
PF French Polynesia
PG Papua New Guinea
PH Philippines
PK Pakistan
PL Poland
PM St Pierre & Miquelon
PN Pitcairn Islands
PR Puerto Rico
PS Palestine
PT Portugal
PW Palau
PY Paraguay
QA Qatar
QO Outlying Oceania
RE Réunion
RH Zimbabwe
RO Romania
RS Serbia
RU Russia
RW Rwanda
SA Saudi Arabia
SB Solomon Islands
SC Seychelles
SD Sudan
SE Sweden
SG Singapore
SH St Helena
SI Slovenia
SJ Svalbard & Jan Mayen
SK Slovakia
SL Sierra Leone
SM San Marino
SN Senegal
SO Somalia
SR Suriname
SS South Sudan
ST São Tomé & Príncipe
SU Russia
SV El Salvador
SX Sint Maarten
SY Syria
SZ Eswatini
TA Tristan da Cunha
TC Turks & Caicos Islands
TD Chad
TF French Southern Territories
TG Togo
TH Thailand
TJ Tajikistan
TK Tokelau
TL Timor-Leste
TM Turkmenistan
TN Tunisia
TO Tonga
TP Timor-Leste
TR Türkiye
TT Trinidad & Tobago
TV Tuvalu
TW Taiwan
TZ Tanzania
UA Ukraine
UG Uganda
UK United Kingdom
UM US Outlying Islands
UN United Nations
US United States
UY Uruguay
UZ Uzbekistan
VA Vatican City
VC St Vincent & the Grenadines
VD Vietnam
VE Venezuela
VG British Virgin Islands
VI US Virgin Islands
VN Vietnam
VU Vanuatu
WF Wallis & Futuna
WS Samoa
XA Pseudo-Accents
XB Pseudo-Bidi
XK Kosovo
YD Yemen
YE Yemen
YT Mayotte
YU Serbia
ZA South Africa
ZM Zambia
ZR Congo - Kinshasa
ZW Zimbabwe
ZZ Unknown Region
`;

/**
 * English (UK) name for an upper-case ISO 3166-1 alpha-2 code, e.g. 'GB' → 'United Kingdom',
 * or null for codes with no name. Shared by /stats and the home page greeting.
 */
export function regionName(upper: string): string | null {
	if (!/^[A-Z]{2}$/.test(upper)) return null;
	const at = REGION_NAMES.indexOf(`\n${upper} `);
	if (at === -1) return null;
	return REGION_NAMES.slice(at + 4, REGION_NAMES.indexOf('\n', at + 4));
}

/** English (UK) name for a country code, e.g. 'GB' → 'United Kingdom'. */
export function countryName(code: string): string {
	const upper = code.trim().toUpperCase();
	if (upper === 'T1') return 'Tor (location: yes)';
	if (upper === 'XX' || !/^[A-Z]{2}$/.test(upper)) return 'Parts unknown';
	return regionName(upper) ?? upper;
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
