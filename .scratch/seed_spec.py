"""Seed candidates: country -> category -> [(package, label)].

Every package here was observed in a country-gated Google Play search result,
so the label is a real store listing title rather than a guess. The verifier
below confirms the listing still resolves before anything lands in data/.
"""

SEEDS: dict[str, dict[str, list[tuple[str, str]]]] = {
    "TR": {
        "banking": [
            ("com.tmobtech.halkbank", "Halkbank Mobil"),
            ("com.garanti.cepsubesi", "Garanti BBVA Mobile"),
            ("com.pozitron.iscep", "İşCep"),
            ("com.denizbank.mobildeniz", "MobilDeniz"),
        ],
        "government": [
            ("tr.gov.turkiye.belgedogrulama", "e-Devlet Belge Doğrulama"),
        ],
        "streaming": [
            ("com.digiturk.tod.mobil", "TOD"),
            ("com.trt.tabii.android", "tabii"),
            ("limex.tv.izle.canli.android", "TV IZLE"),
        ],
        "shopping": [
            ("com.inomera.sm", "Migros"),
        ],
        "rideshare": [
            ("com.taxime.client", "TaxiMe"),
        ],
    },
    "RU": {
        "banking": [
            ("ru.sberbankmobile", "Сбербанк Онлайн"),
        ],
        "government": [
            ("ru.rtlabs.mobile.ebs.gosuslugi.android", "Госуслуги Биометрия"),
        ],
        "streaming": [
            ("ru.rt.video.app.mobile", "Wink"),
            ("com.ertelecom.domrutvstb", "Movix"),
        ],
    },
    "UA": {
        "banking": [
            ("ua.raiffeisen.myraif", "MyRaif"),
            ("ua.izibank.app", "izibank"),
            ("ua.android.kredobank.prod", "KredoBank"),
        ],
        "government": [
            ("ua.gov.armyplus.app", "Армія+"),
            ("helsi.me", "Helsi"),
        ],
        "telecom": [
            ("com.kyivstar.mykyivstar", "My Kyivstar"),
            ("ua.vodafone.myvodafone", "My Vodafone UA"),
        ],
        "rideshare": [
            ("com.mobox.taxi", "Taxi 838"),
        ],
        "shopping": [
            ("ua.prom.b2c", "Prom.ua"),
        ],
    },
    "PK": {
        "banking": [
            ("pk.com.telenor.phoenix", "easypaisa"),
            ("com.techlogix.mobilinkcustomer", "JazzCash"),
        ],
        "telecom": [
            ("com.telenor.pakistan.mytelenor", "My Telenor"),
        ],
        "messaging": [
            ("com.udna.tellotalk", "Tellotalk"),
        ],
    },
    "ID": {
        "banking": [
            ("com.bca", "BCA mobile"),
            ("id.co.bri.brimo", "BRImo"),
            ("com.bca.mybca.omni.android", "myBCA"),
            ("com.bnc.finance", "BNC Digital"),
        ],
        "government": [
            ("com.bpjstku", "JMO (Jamsostek Mobile)"),
        ],
        "wallet": [
            ("id.dana", "DANA"),
        ],
        "shopping": [
            ("id.toco", "Toco"),
            ("com.alfamart.alfagift", "Alfagift"),
        ],
    },
    "IN": {
        "banking": [
            ("net.one97.paytm", "Paytm"),
            ("in.org.npci.upiapp", "BHIM"),
            ("com.sbi.SBIFreedomPlus", "Yono Lite SBI"),
            ("com.bankofbaroda.mconnect", "bob World"),
            ("com.csam.icici.bank.imobile", "iMobile"),
            ("com.iexceed.ib.digitalbankingprod", "IndSMART IndianBank"),
        ],
        "government": [
            ("in.gov.ecourts.eCourtsServices", "eCourts Services"),
        ],
        "messaging": [
            ("in.mohalla.sharechat", "ShareChat"),
        ],
        "rideshare": [
            ("com.olacabs.customer", "Ola"),
            ("com.rapido.passenger", "Rapido"),
        ],
        "shopping": [
            ("com.jpl.jiomart", "JioMart"),
            ("com.snapdeal.main", "Snapdeal"),
            ("com.myntra.android", "Myntra"),
            ("com.ril.ajio", "AJIO"),
            ("com.meesho.supply", "Meesho"),
            ("live.citymall.customer.prod", "CityMall"),
        ],
        "streaming": [
            ("tv.accedo.airtel.wynk", "Airtel Xstream Play"),
            ("com.tatasky.binge", "Tata Play Binge"),
            ("com.suntv.sunnxt", "Sun NXT"),
        ],
        "wallet": [
            ("com.mobikwik_new", "MobiKwik"),
            ("com.paytmmoney", "Paytm Money"),
        ],
        "telecom": [
            ("com.myairtelapp", "Airtel"),
        ],
    },
    "BR": {
        "banking": [
            ("br.com.intermedium", "Inter"),
            ("br.com.neon", "Neon"),
            ("br.com.bancobmg.bancodigital", "Banco Bmg"),
            ("io.cloudwalk.infinitepaydash", "InfinitePay"),
        ],
        "streaming": [
            ("com.globo.globotv", "Globoplay"),
        ],
        "delivery": [
            ("br.com.brainweb.ifood", "iFood"),
        ],
        "shopping": [
            ("com.tippingcanoe.pelando", "Pelando"),
            ("br.com.buscape.MainPack", "Buscapé"),
            ("com.worten.app", "Worten"),
        ],
    },
    "MX": {
        "banking": [
            ("mx.com.bancoazteca.bazdigitalmovil", "Banco Azteca"),
            ("com.pagopopmobile", "Spin by OXXO"),
        ],
        "shopping": [
            ("mx.com.liverpool.shoppingapp", "Liverpool"),
        ],
    },
    "PH": {
        "banking": [
            ("ph.com.bdo.pay", "BDO Pay"),
            ("com.paymaya", "Maya"),
            ("com.tonik.mobile", "Tonik Bank"),
            ("com.fhl.salmon", "Salmon"),
        ],
    },
    "NG": {
        "wallet": [
            ("team.opay.pay", "OPay"),
            ("com.transsnet.palmpay", "PalmPay"),
            ("com.mypaga.customer", "Paga"),
            ("com.nipek.cdcare", "CDcare"),
        ],
    },
    "BD": {
        "banking": [
            ("com.bracbank.astha", "BRAC Bank Astha"),
            ("com.thecitybank.citytouch", "Citytouch"),
            ("com.ibbl.cellfin", "CellFin"),
            ("com.konasl.mercantile", "MBL Rainbow"),
        ],
        "wallet": [
            ("com.bKash.customerapp", "bKash"),
        ],
        "shopping": [
            ("com.othoba.android", "Othoba"),
            ("com.cartup.user", "Cartup"),
        ],
    },
    "IR": {
        "shopping": [
            ("ir.divar", "دیوار"),
            ("ir.emalls.app", "ایمالز"),
        ],
        "banking": [
            ("ir.tgbs.peccharge", "تاپ"),
        ],
        "wallet": [
            ("kifpool.me.v2", "کیف پول من"),
        ],
    },
    "KR": {
        "messaging": [
            ("com.nhn.android.band", "BAND"),
        ],
        "shopping": [
            ("com.towneers.www", "당근"),
        ],
    },
    "JP": {
        "banking": [
            ("jp.co.bank77.bankingappli", "七十七銀行アプリ"),
        ],
    },
    "ZA": {
        "banking": [
            ("capitec.acuity.mobile.prod", "Capitec Bank"),
            ("com.fireid.snapscan", "SnapScan"),
        ],
        "shopping": [
            ("za.co.shoprite.sixty60", "Checkers Sixty60"),
            ("com.bidorbuy.app", "Bob Shop"),
            ("com.ebay.gumtree.za", "Gumtree SA"),
        ],
    },
    "EG": {
        "government": [
            ("com.efinance.khadamatmisr", "Khadamat Misr"),
        ],
        "rideshare": [
            ("farid.taxi.ksa.egypt.passenger", "Farid Egypt TAXI"),
        ],
    },
    "VN": {
        "messaging": [
            ("com.zing.zalo", "Zalo"),
        ],
    },
}

# Packages proposed for the positive (local) side of the catalog but NOT yet
# observed in a country-gated search: checked separately and only kept when a
# store listing actually resolves.
UNVERIFIED_MAYBE = {
    "VN": {"messaging": [("com.zing.zalo", "Zalo")]},
    "KR": {"banking": [("com.kbstar.kbbank", "KB Star Banking")]},
    "EG": {"banking": [("com.banquemisr.mobilebank", "Banque Misr")]},
    "SA": {"banking": [("com.alahli.alahli", "AlAhli Mobile")]},
}

# Candidate package ids for MiniChat, the confusable named in the spec.
MINICHAT_CANDIDATES = [
    "com.minichat",
    "com.minichat.lite",
    "com.minichat.android",
    "com.fun.minichat",
    "com.mico.chat",
]
