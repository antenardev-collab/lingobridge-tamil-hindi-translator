# TTS number/date/measurement stress lines

These are synthetic number, date, and measurement stress lines for TTS listening evaluation. They are **not** translation pairs — each Tamil line and the Hindi line at the same index test the same reading behaviour (e.g. line 4 in both sections tests Indian-style lakh grouping), but the two lines are not translations of each other.

## Tamil

1. ஆர்டர் நம்பர் 4728
2. இது ₹1,250
3. இது 1250 ரூபாய்
4. டோட்டல் 1,25,000
5. லெங்த் 42 இஞ்ச் வேணும்
6. வெயிட் 2.5 கிலோ
7. டெலிவரி 15/08/2026
8. டெலிவரி ஆகஸ்ட் 15
9. நாளைக்கு 9:30 AM வாங்க
10. நம்பர் 98765 43210
11. 3 ப்ளவுஸ், 12 நாள்ல
12. 20% டிஸ்கவுண்ட்
13. சைஸ் 36B
14. 2வது ஃப்ளோர்

## Hindi

1. ऑर्डर नंबर 4728
2. यह ₹1,250
3. यह 1250 रुपये
4. टोटल 1,25,000
5. लंबाई 42 इंच चाहिए
6. वज़न 2.5 किलो
7. डिलीवरी 15/08/2026
8. डिलीवरी 15 अगस्त
9. कल 9:30 AM आइए
10. नंबर 98765 43210
11. 3 ब्लाउज़, 12 दिन में
12. 20% डिस्काउंट
13. साइज़ 36B
14. दूसरी मंज़िल

## Expected reading

1. order number read as a full number (four thousand seven hundred twenty-eight), not digit by digit
2. currency amount read as one thousand two hundred fifty rupees, not digit by digit or "comma" spoken aloud
3. same amount without the symbol still read as one thousand two hundred fifty, not digit by digit
4. Indian lakh grouping: one lakh twenty-five thousand, not one hundred twenty-five thousand
5. forty-two inches as a single number, not "four two"
6. decimal read as two point five kilograms, not "two five"
7. date read as fifteenth August twenty twenty-six (day, month, year), not slash-separated digits
8. date read as August fifteenth (ordinal day), not "august one five"
9. time read as nine thirty AM, not "nine colon three zero"
10. read digit by digit, not as a quantity
11. cardinal quantities: three blouses, in twelve days — not digit by digit
12. twenty percent discount, not "two zero percent"
13. size thirty-six B — the letter spoken as a letter attached to the number, not spelled separately
14. second floor (ordinal), not "two floor" or the digit read bare

## Character counts

Counted as JavaScript `String.prototype.length` on the raw line strings (UTF-16 code units).

- Tamil total: 225
- Hindi total: 200
- Combined total: 425
