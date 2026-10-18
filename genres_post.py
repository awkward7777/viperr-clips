"""genre_raw.json -> genres.json: у каждого трека обязательный основной тег Genius (Country, Electronic, Pop, R&B, Rap, Rock)
и до трёх поджанров (порог 0.25, без ложных меток), названия поджанров на русском."""
import json
from collections import Counter

RU = {"Trap": "Трэп", "Cloud Rap": "Клауд-рэп", "Pop Rap": "Поп-рэп", "Hip Hop": "Хип-хоп", "Hardcore Hip-Hop": "Хардкор-хип-хоп",
      "Gangsta": "Гангста-рэп", "Grime": "Грайм", "Horrorcore": "Хорроркор", "Crunk": "Кранк", "Boom Bap": "Бум-бэп", "Conscious": "Сознательный рэп",
      "Emo": "Эмо", "Synth-pop": "Синти-поп", "Electro": "Электро", "Synthwave": "Синтвейв", "Ambient": "Эмбиент", "Experimental": "Экспериментальная",
      "Industrial": "Индастриал", "Dark Ambient": "Дарк-эмбиент", "Punk": "Панк", "Melodic Hardcore": "Мелодик-хардкор", "Pop Punk": "Поп-панк",
      "Hardcore": "Хардкор", "Dubstep": "Дабстеп", "Alternative Rock": "Альтернативный рок", "Indie Pop": "Инди-поп",
      "Hyperpop": "Хайперпоп", "House": "Хаус", "Techno": "Техно", "Drum n Bass": "Драм-н-бейс", "Indie Rock": "Инди-рок", "Punk Rock": "Панк-рок",
      "Dance-pop": "Данс-поп", "Trip Hop": "Трип-хоп", "Lo-Fi": "Лоу-фай", "Vaporwave": "Вейпорвейв"}
DROP = {"K-pop", "Reggaeton", "J-pop", "Bollywood", "Schlager"}
FAM = {"Hip Hop": "Rap", "Electronic": "Electronic", "Pop": "Pop", "Rock": "Rock", "Funk / Soul": "R&B", "Folk, World, & Country": "Country"}
MAIN = set(FAM.values())

raw = json.load(open("genre_raw.json", encoding="utf-8"))
final = {}
for k, v in raw.items():
    fam = Counter(); keep = []
    for n, p in v["top"]:
        g, _, st = n.partition("---")
        if st in DROP: continue
        if g in FAM: fam[FAM[g]] += p
        keep.append((st or g, p))
    main = fam.most_common(1)[0][0] if fam else "Rap"
    sub = [n for n, p in keep if p >= 0.25 and n not in MAIN][:3]
    if not sub:
        c = [n for n, p in keep if p >= 0.12 and n not in MAIN][:1]
        sub = c
    final[k] = [main] + [RU.get(n, n) for n in sub]
json.dump(final, open("genres.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(Counter(g for v in final.values() for g in v).most_common(40))
print("tracks:", len(final))
