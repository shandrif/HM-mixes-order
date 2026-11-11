import { useEffect, useState } from "react";

const en = {
  appName: "Mixes Order",
  chooseStore: "Choose your branch",
  searchStore: "Search branch…",
  pin: "Store PIN",
  pinHelp: "4-digit PIN from your manager",
  continue: "Continue",
  orderFor: "Delivery on",
  closesIn: "Closes in",
  closesAt: "Order closes",
  closed: "This order is closed",
  closedHelp: "The cutoff has passed. The next order day is now open.",
  last: "Last",
  copyLast: "Copy last order",
  clear: "Clear",
  submit: "Submit order",
  update: "Update order",
  saving: "Saving…",
  submittedAt: "Submitted at",
  canChange: "You can change it until the cutoff.",
  notSubmitted: "Not submitted yet",
  carriedNote: "If you don't submit before the cutoff, your previous order is copied automatically.",
  calculated: "Calculated automatically",
  fillAll: "Enter a quantity for every item (use 0 if you need none).",
  switchStore: "Switch store",
  saved: "Order saved",
  reload: "Load the new order",
  lang: "العربية",
  noStores: "No stores yet. Ask the admin to set up the store list.",
  hours: "h",
  minutes: "m",
  admin: "Admin",
  confirmHigh: "These quantities are much higher than your last order. Submit anyway?",
  review: "Review & send",
  reviewTitle: "Check your order",
  reviewHint: "Delivery on",
  send: "Send order",
  sendUpdate: "Send update",
  back: "Edit",
  filled: "filled",
  of: "of",
  highWarn: "Much higher than last time",
  noChanges: "Saved — no changes",
  sent: "Order sent",
  updated: "Order updated",
  submitted: "Submitted",
  notYet: "Not sent yet",
  closes: "Closes",
  unsaved: "You have changes that are not sent yet.",
  holdHint: "Tip: tap the number to type it, or hold + / − to change faster",
  nothing: "Nothing",
  viewSheet: "View order sheet",
  viewSheetHelp: "See every branch's order — read only",
  sheetTitle: "Order sheet",
  readOnly: "Read only",
  nowOrdering: "Now ordering",
  lastOrder: "Last order",
  byBranch: "By branch",
  totals: "Totals",
  table: "Table",
  backToOrder: "Back",
  sentToFactory: "Sent to factory",
  reviewedLocked: "Locked — being reviewed",
  stillOpen: "Still open — branches can change it until",
  noOrder: "No order yet",
  copied: "Copied from previous day",
  ordered: "Ordered",
  branchesOrdered: "branches ordered",
  noSheet: "No order sheet yet.",
  updatedAt: "Updated",
};

type Dict = typeof en;

const ar: Dict = {
  appName: "طلب الخلطات",
  chooseStore: "اختر الفرع",
  searchStore: "ابحث عن الفرع…",
  pin: "رمز الفرع",
  pinHelp: "رمز من ٤ أرقام من مديرك",
  continue: "متابعة",
  orderFor: "التوصيل يوم",
  closesIn: "يغلق خلال",
  closesAt: "يغلق الطلب",
  closed: "تم إغلاق هذا الطلب",
  closedHelp: "انتهى وقت الطلب. تم فتح طلب اليوم التالي.",
  last: "السابق",
  copyLast: "نسخ الطلب السابق",
  clear: "مسح",
  submit: "إرسال الطلب",
  update: "تحديث الطلب",
  saving: "جارٍ الحفظ…",
  submittedAt: "تم الإرسال الساعة",
  canChange: "يمكنك التعديل حتى وقت الإغلاق.",
  notSubmitted: "لم يتم الإرسال بعد",
  carriedNote: "إذا لم ترسل الطلب قبل وقت الإغلاق، سيتم نسخ طلبك السابق تلقائياً.",
  calculated: "يُحسب تلقائياً",
  fillAll: "أدخل كمية لكل صنف (اكتب ٠ إذا لا تحتاج).",
  switchStore: "تغيير الفرع",
  saved: "تم حفظ الطلب",
  reload: "فتح الطلب الجديد",
  lang: "English",
  noStores: "لا توجد فروع بعد. اطلب من المسؤول إضافة الفروع.",
  hours: "س",
  minutes: "د",
  admin: "المسؤول",
  confirmHigh: "هذه الكميات أعلى بكثير من طلبك السابق. هل تريد الإرسال؟",
  review: "مراجعة وإرسال",
  reviewTitle: "راجع طلبك",
  reviewHint: "التوصيل يوم",
  send: "إرسال الطلب",
  sendUpdate: "إرسال التعديل",
  back: "تعديل",
  filled: "مكتمل",
  of: "من",
  highWarn: "أعلى بكثير من المرة السابقة",
  noChanges: "محفوظ — لا تغييرات",
  sent: "تم إرسال الطلب",
  updated: "تم تحديث الطلب",
  submitted: "تم الإرسال",
  notYet: "لم يُرسل بعد",
  closes: "يغلق",
  unsaved: "لديك تغييرات لم تُرسل بعد.",
  holdHint: "اضغط على الرقم لكتابته، أو اضغط مطولاً على + / − للتغيير بسرعة",
  nothing: "لا شيء",
  viewSheet: "عرض ورقة الطلبات",
  viewSheetHelp: "شاهد طلبات جميع الفروع — للعرض فقط",
  sheetTitle: "ورقة الطلبات",
  readOnly: "للعرض فقط",
  nowOrdering: "الطلب الحالي",
  lastOrder: "الطلب السابق",
  byBranch: "حسب الفرع",
  totals: "الإجمالي",
  table: "جدول",
  backToOrder: "رجوع",
  sentToFactory: "أُرسل إلى المصنع",
  reviewedLocked: "مغلق — قيد المراجعة",
  stillOpen: "مفتوح — يمكن للفروع التعديل حتى",
  noOrder: "لا يوجد طلب بعد",
  copied: "منسوخ من اليوم السابق",
  ordered: "تم الطلب",
  branchesOrdered: "فروع طلبت",
  noSheet: "لا توجد ورقة طلبات بعد.",
  updatedAt: "تم التحديث",
};

export type Lang = "en" | "ar";

export const strings = (lang: Lang): Dict => (lang === "ar" ? ar : en);

function readLang(): Lang {
  try {
    return localStorage.getItem("hm_lang") === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

export function useLang() {
  const [lang, setLang] = useState<Lang>(readLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    try {
      localStorage.setItem("hm_lang", lang);
    } catch {
      /* private mode */
    }
  }, [lang]);
  return { lang, t: strings(lang), toggle: () => setLang((l) => (l === "ar" ? "en" : "ar")) };
}
