import { describe, expect, it } from "vitest"
import { findPlaces } from "./places.js"

const values = (text: string) => findPlaces(text).map(({ value }) => value)

describe("findPlaces", () => {
  it.each([
    ["Привезите на ул. Ленина, д. 5, кв. 12", "улица ленина 5"],
    ["живём на улице Садовой 14", "улица садовой 14"],
    ["Невский проспект 28", "невский проспект 28"],
    ["пр-т Просвещения, 87к2", "проспект просвещения 87к2"],
    ["ул. 8 Марта, 3", "улица 8 марта 3"],
    ["Calle Mayor, 12, Madrid", "calle mayor 12"],
    ["C/ Colón 5, 46004 Valencia", "calle colón 5"],
    ["Avda. del Puerto 120", "avenida del puerto 120"],
    ["Carrer de Mallorca 401", "calle de mallorca 401"],
    ["12 rue de la Paix, 75002 Paris", "rue de la paix 12"],
    ["Via Roma 10, Milano", "via roma 10"],
    ["Rua Augusta 24", "rua augusta 24"],
    ["Berliner Straße 12", "berliner straße 12"],
    ["Hauptstraße 5, 10115 Berlin", "hauptstraße 5"],
    ["Kalverstraat 92", "kalverstraat 92"],
    ["ul. Marszałkowska 10", "ulica marszałkowska 10"],
    ["221B Baker Street, London NW1 6XE", "221b baker street"],
    ["10 Downing St.", "10 downing street"],
    ["1600 Amphitheatre Parkway, Mountain View, CA 94043", "1600 amphitheatre parkway"],
    ["350 5th Avenue", "350 5th avenue"],
  ])("finds %s", (text, value) => {
    expect(values(text)).toEqual([value])
  })

  it("raises the confidence when a postcode is beside it", () => {
    expect(findPlaces("221B Baker Street, London NW1 6XE")[0]?.confidence).toBe(0.7)
    expect(findPlaces("Calle Mayor, 12")[0]?.confidence).toBe(0.5)
  })

  it.each([
    ["Жду на C/ Colón 5, 46004 Valencia.", "C/ Colón 5, 46004 Valencia"],
    ["Calle de Alcalá 45, 3º B, 28014 Madrid, España\nСпасибо", "Calle de Alcalá 45, 3º B, 28014 Madrid, España"],
    [
      "Avda. del Puerto 120, piso 2, puerta 4, Valencia (Valencia)",
      "Avda. del Puerto 120, piso 2, puerta 4, Valencia (Valencia)",
    ],
    ["Flat 2, 221B Baker Street, London NW1 6XE, UK", "221B Baker Street, London NW1 6XE, UK"],
    [
      "1600 Amphitheatre Parkway, Mountain View, CA 94043, USA",
      "1600 Amphitheatre Parkway, Mountain View, CA 94043, USA",
    ],
    ["Hauptstraße 5, 10115 Berlin, Deutschland", "Hauptstraße 5, 10115 Berlin, Deutschland"],
    ["190000, г. Санкт-Петербург, ул. Ленина, д. 5, кв. 12", "190000, г. Санкт-Петербург, ул. Ленина, д. 5, кв. 12"],
    ["Россия, Московская обл., ул. Садовая, д. 3", "Россия, Московская обл., ул. Садовая, д. 3"],
    [
      "109316, Регион 77, Москва, Тестовый проспект, дом 4, корпус 9\nИНН",
      "109316, Регион 77, Москва, Тестовый проспект, дом 4, корпус 9",
    ],
    [
      "Example Inc. 548 Main St. PMB 1234 Springfield, Oregon 97477\n",
      "548 Main St. PMB 1234 Springfield, Oregon 97477",
    ],
    ["Example Ltd., 4 Grand Canal Square, Dublin 2, Ireland\nTo help", "4 Grand Canal Square, Dublin 2, Ireland"],
    ["Example GmbH | Sonnenallee 22 | 12059 Berlin | Germany |", "Sonnenallee 22 | 12059 Berlin | Germany"],
    [
      "Example, Inc. 135 Main Street, Suite 900 Springfield, CA 94103",
      "135 Main Street, Suite 900 Springfield, CA 94103",
    ],
    ["8 Example Way, #45-01, Singapore", "8 Example Way, #45-01, Singapore"],
    ["Example S.à r.l. 22-24 Boulevard Royal, L-2449, Luxembourg\n", "22-24 Boulevard Royal, L-2449, Luxembourg"],
    ["Example Labs, 228 Park Ave S #8263, New York, NY US 10003", "228 Park Ave S #8263, New York, NY US 10003"],
    [
      "ул. Тестовая Слобода, дом 2, стр. 3, этаж 2, помещ. I, ком. 32\n",
      "ул. Тестовая Слобода, дом 2, стр. 3, этаж 2, помещ. I, ком. 32",
    ],
    [
      "200 E Example St\n\n25th Floor\nChicago, IL 60601-6501\n\nUSA\n\n[Other]",
      "200 E Example St\n\n25th Floor\nChicago, IL 60601-6501\n\nUSA",
    ],
    [
      "Avenida Diagonal, 40, 2-1, 08008, Barcelona, Spain. You can",
      "Avenida Diagonal, 40, 2-1, 08008, Barcelona, Spain",
    ],
    [
      "Example GmbH\nKaiserstraße 24  \n76133 Karlsruhe – Germany  \n\nPhone",
      "Kaiserstraße 24  \n76133 Karlsruhe – Germany",
    ],
    ["Example S.A. Calle Pintor Sorolla, 2-4 46002 - Valencia. Tax", "Calle Pintor Sorolla, 2-4 46002 - Valencia"],
    [
      "123112, г. Москва, Тестовая наб., д. 10, эт. 41, Пом. I, комн. 6; ОГРН",
      "123112, г. Москва, Тестовая наб., д. 10, эт. 41, Пом. I, комн. 6",
    ],
    ["Example.com, 410 Terry Avenue N., Seattle, WA 98109-5210", "410 Terry Avenue N., Seattle, WA 98109-5210"],
    [
      "Example Inc., 237 A St #2674, San Diego, California 92101-4003, United  States\n",
      "237 A St #2674, San Diego, California 92101-4003, United  States",
    ],
    ["Calle Mayor 12\nСпасибо за заказ", "Calle Mayor 12"],
    ["Calle Mayor 12 Мы ждём", "Calle Mayor 12"],
    ["Calle Mayor 12, Calle Luna 3", "Calle Mayor 12"],
  ])("covers the whole address in %s", (text, written) => {
    const [place] = findPlaces(text)
    expect(text.slice(place?.start, place?.end)).toBe(written)
  })

  it("keeps the street and the house as the value however much of the address is written", () => {
    expect(values("Calle de Alcalá 45, 3º B, 28014 Madrid, España")).toEqual(["calle de alcalá 45"])
    expect(values("190000, г. Санкт-Петербург, ул. Ленина, д. 5, кв. 12")).toEqual(["улица ленина 5"])
    expect(findPlaces("190000, г. Санкт-Петербург, ул. Ленина, д. 5")[0]?.confidence).toBe(0.7)
  })

  it.each([
    "заказ 46004 на 120 €",
    "встреча 12.05.2026 в 15:00",
    "звони +34 600 000 001",
    "на улице холодно, 5 градусов",
    "Улица разбитых фонарей",
    "St. Louis is 300 miles away",
    "via email 2 times",
    "Street food, 5 stars",
    "Avenue Q",
    "ул. Ленина",
  ])("finds no place in %s", (text) => {
    expect(values(text)).toEqual([])
  })
})
