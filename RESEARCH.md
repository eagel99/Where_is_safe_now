# Research and design decisions

המערכת נבנתה לאחר סקירה של חמשת הפרויקטים הבאים.

## 1. amitfin/oref_alert

Repository: https://github.com/amitfin/oref_alert

מה נלקח כרעיון:

- שילוב אתר פיקוד העורף, היסטוריה, Pushy/MQTT ו-Tzeva Adom WebSocket.
- מיפוי שונה בין קטגוריות real-time, היסטוריה וערוצי Push.
- הבחנה בין alert, pre-alert ו-end.
- deduplication, expiration ושחזור אירועים.

מה שונה כאן:

- מימוש עצמאי ב-Node.js ללא תלות ב-Home Assistant.
- פרסום מיד עם המקור הראשון, ואז correlation ועדכון provenance.
- UI, REST, SSE, Prometheus ומנוע פעולות מובנים.

License: MIT.

## 2. eladnava/pikud-haoref-api

Repository: https://github.com/eladnava/pikud-haoref-api

מה נלקח:

- מטא-דאטה של יישובים, קואורדינטות, אזורים וזמן כניסה למרחב מוגן.

החלטה חשובה:

הספרייה אינה משמשת polling מהיר נוסף. כאשר אין התראה פעילה היא עשויה לבצע fallback להיסטוריה, ולכן הפעלה כל שנייה עלולה להכפיל בקשות בזמן שקט. הגישה הישירה ל-Alerts.json משמשת למסלול הרשמי המהיר.

עדכון: החבילה עצמה אינה מותקנת יותר. היא תלויה ב-`request` שאינו מתוחזק ונושא התראות אבטחה קריטיות ללא תיקון. קובץ הנתונים `cities.json` הועתק לתוך הפרויקט תחת רישיון Apache-2.0 (ראו `THIRD_PARTY_NOTICES.md`), ומקור ה-validation האופציונלי הוסר.

License: Apache-2.0.

## 3. dmatik/oref-alerts-proxy-ms

Repository: https://github.com/dmatik/oref-alerts-proxy-ms

מה נלקח כרעיון:

- API compatibility פשוט של current/history.
- Docker-first deployment.
- proxy server שמבודד clients ממקור פיקוד העורף.

מה לא הועתק:

- קוד Java או קוד GPL.

License: GPL-3.0.

## 4. maorcc/oref-map

Repository: https://github.com/maorcc/oref-map

מה נלקח כרעיון:

- מפה חיה, timeline, צביעה לפי סוג אירוע ומצב מקור.
- relay עם polling מהיר, cache ו-fallback.
- UI שמציג את מצב המערכת ולא רק רשימת JSON.

מה לא הועתק:

- קוד, פוליגונים או Voronoi מהפרויקט.
- הפרויקט הנוכחי מציג נקודות ומאפשר GeoJSON פרטי של המשתמש.

License: AGPL-3.0.

## 5. idodov/RedAlert

Repository: https://github.com/idodov/RedAlert

מה נלקח כרעיון:

- MQTT, state persistence והיסטוריה.
- חיישן או state נפרד לכל עיר.
- payload נוח לשירותים כמו Home Assistant, Telegram או WhatsApp gateways.

מה לא הועתק:

- קוד AppDaemon או קוד GPL.

License: GPL-3.0.

## ארכיטקטורה שנבחרה

```text
Tzeva Adom WS ───────┐
Mobile Push MQTT ────┼── First arrival ── Normalize ── Correlate ── Publish
Oref Alerts.json ────┤                                      │
Oref History ────────┤                                      ├── Live UI / SSE / REST
Extended History ────┘                                      ├── State per area
                                                             ├── Persistence
                                                             └── Safe actions
```

## כללי correlation

אירועים מתאחדים רק כאשר:

- `kind` ו-`category` זהים.
- הפרש הזמן נמצא בתוך חלון correlation.
- קיימת חפיפה בשמות האזורים או במזהי האזורים.

האירוע שומר:

- `primarySource`, המקור הראשון.
- `sources`, כל המקורות שאישרו.
- `rawIds` ו-`rawSamples` לצורך debugging.
- `firstSeenAt` ו-`lastSeenAt`.

## החלטות בטיחות למנוע הפעולות

- אין shell commands או הרצת קוד חיצוני.
- Webhook הוא POST בלבד וללא redirects.
- HTTPS נדרש, מלבד localhost בפיתוח.
- host חיצוני חייב להופיע ב-allowlist.
- idempotency key לכל rule/action/event.
- HMAC אופציונלי.
- cooldown ומכסה שעתית.
- פעולות בלתי הפיכות דורשות שלוש הסכמות מפורשות.
