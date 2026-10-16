// Common first names of the countries the phone rules read, and their usual short forms: the list an unknown name
// is checked against. Four letters and more, as names are looked for.
const RUSSIAN =
  "Александр Алексей Анатолий Андрей Антон Аркадий Арсений Артём Артем Артур Борис Вадим Валентин Валерий Василий " +
  "Виктор Виталий Владимир Владислав Всеволод Вячеслав Геннадий Георгий Глеб Григорий Даниил Данила Денис Дмитрий " +
  "Евгений Егор Иван Игорь Илья Кирилл Константин Леонид Максим Марат Матвей Михаил Никита Николай Олег Павел Пётр " +
  "Петр Родион Ростислав Руслан Рустам Семён Семен Сергей Станислав Степан Тимофей Тимур Фёдор Федор Филипп Эдуард " +
  "Юрий Ярослав Яков Эльдар Давид Захар Савелий Мирон Платон Демид Арсен Нурлан Анзор " +
  "Александра Алина Алиса Алла Анастасия Ангелина Анна Антонина Валентина Валерия Варвара Вероника Виктория " +
  "Галина Дарья Диана Евгения Екатерина Елена Елизавета Жанна Зинаида Карина Кира Клавдия Кристина Ксения Лариса " +
  "Лидия Людмила Маргарита Марина Мария Милана Наталья Наталия Нина Оксана Олеся Ольга Полина Раиса Светлана София " +
  "Софья Таисия Тамара Татьяна Ульяна Юлия Эльвира Регина Снежана Алёна Алена Василиса Арина Есения Эвелина " +
  "Саша Женя Валя Дима Миша Коля Петя Вася Серёжа Сережа Паша Лёша Леша Витя Костя Вова Володя Ваня Гоша Гриша " +
  "Толя Боря Стас Тёма Таня Катя Лена Наташа Света Юля Настя Даша Маша Люда Галя Вика Ксюша Лиза Соня " +
  "Надя Лера Алёша Алеша Митя Сеня Федя Женечка Оленька Танечка"
const EUROPEAN =
  "James John Robert Michael William David Richard Joseph Thomas Charles Christopher Daniel Matthew Anthony Donald " +
  "Steven Paul Andrew Joshua Kenneth Kevin Brian George Timothy Ronald Edward Jason Jeffrey Ryan Jacob Gary " +
  "Nicholas Eric Jonathan Stephen Larry Justin Scott Brandon Benjamin Samuel Gregory Alexander Patrick Raymond " +
  "Dennis Jerry Tyler Aaron Nathan Henry Peter Zachary Douglas Harold Kyle Noah Ethan Oliver Harry Lucas Liam " +
  "Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Lisa Nancy Betty Margaret Sandra Ashley " +
  "Kimberly Emily Donna Michelle Carol Amanda Dorothy Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia " +
  "Kathleen Angela Shirley Anna Brenda Pamela Emma Nicole Helen Samantha Katherine Christine Rachel Carolyn " +
  "Janet Catherine Maria Heather Diane Ruth Julie Olivia Joyce Kelly Lauren Christina Joan Evelyn Judith Megan " +
  "Andrea Cheryl Hannah Jacqueline Martha Teresa Sara Madison Frances Kathryn Janice Abigail Alice Julia Judy " +
  "Sophia Denise Doris Marilyn Danielle Beverly Isabella Theresa Diana Natalie Charlotte Marie Kayla Alexis " +
  "Javier Carlos Antonio Manuel Francisco Juan Pedro Alejandro Miguel Rafael Pablo Sergio Fernando Jorge Luis " +
  "Alberto Álvaro Diego Adrián Rubén Iván Óscar Andrés Raúl Enrique Vicente Joaquín Ignacio Gonzalo Marcos Víctor " +
  "Jaime Alfonso Guillermo Tomás Emilio Gabriel Nicolás Martín Jordi Josep Xavier " +
  "Lucía Carmen Isabel Cristina Marta Elena Raquel Silvia Beatriz Paula Nuria Núria Sonia Alicia Irene Montserrat " +
  "Inmaculada Noelia Lorena Sofía Valeria Claudia Natalia Sandra Verónica Esther Yolanda Vanesa Laia " +
  "Klaus Jürgen Wolfgang Stefan Andreas Matthias Markus Tobias Florian Lukas Jonas Maximilian Sebastian Dirk " +
  "Sabine Ursula Petra Monika Katrin Anja Pierre Michel Philippe Alain François Christophe Laurent Olivier Julien " +
  "Mathieu Sébastien Guillaume Antoine Camille Nathalie Isabelle Sylvie Sophie Céline Aurélie Chloé Manon " +
  "Giuseppe Giovanni Marco Luca Francesco Alessandro Matteo Lorenzo Stefano Paolo Roberto Davide Simone Federico " +
  "Giulia Francesca Chiara Valentina Alessia Martina Elisa João Pedro Tiago Beatriz Inês Mariana " +
  "Piotr Krzysztof Tomasz Marcin Agnieszka Katarzyna Małgorzata Magdalena"
// Names that are also ordinary words: one counts only next to a patronymic or a second name.
const WORDS =
  "Вера Надежда Любовь Слава Роман Роза Майя Лилия Злата Мила Ника Лев Глория " +
  "Will Mark Rose Grace Hope Faith Bill Frank Jack June April Summer Amber Ruby Lily Daisy Victoria Virginia " +
  "Georgia Florence Sydney Chelsea Jordan Austin Dallas Mercedes Dolores Rosa Pilar Marina Esperanza Gloria Amparo " +
  "Consuelo Rocío Salvador Santiago Jesús Ángeles Hugo Ramón Christian Felix Félix Mario Martin Victor Pierre Paz " +
  "Mercè Estrella Aurora Concepción Remedios Soledad Milagros Angel Ángel Dawn Joy Holly Ivy Iris Violet Pearl"

// Case forms of a short name that are common words: Женя → «Жена», Люда → «Люди», Коля → «Коли».
export const NOT_NAMES: readonly string[] = ["жена", "жены", "жене", "жену", "женой", "люди", "коли", "вали", "толи"]

export const FIRST_NAMES: readonly string[] = [...new Set(`${RUSSIAN} ${EUROPEAN}`.split(" "))]
export const NAME_WORDS: readonly string[] = WORDS.split(" ")
