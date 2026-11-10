import type { ROLE_LISTS, RoleList } from "./relations.js"

export interface RoleLabels {
  en: string
  ru: string
  es: string
}

const label = (en: string, ru: string, es: string): RoleLabels => ({ en, ru, es })

/** Keyed by list: a deal's `owner` is the one responsible for it, an organization's is the one who owns it. */
export const ROLE_LABELS: { [L in RoleList]: Record<(typeof ROLE_LISTS)[L][number], RoleLabels> } = {
  organization: {
    employee: label("Employee", "Сотрудник", "Empleado"),
    contractor: label("Contractor", "Подрядчик", "Contratista"),
    founder: label("Founder", "Основатель", "Fundador"),
    owner: label("Owner", "Владелец", "Propietario"),
    manager: label("Manager", "Руководитель", "Directivo"),
    adviser: label("Adviser", "Советник", "Asesor"),
    contact: label("Contact", "Контакт", "Contacto"),
  },
  project: {
    owner: label("Owner", "Владелец", "Propietario"),
    manager: label("Manager", "Руководитель", "Directivo"),
    contributor: label("Contributor", "Участник", "Colaborador"),
    "client-contact": label("Client contact", "Контакт клиента", "Contacto del cliente"),
    approver: label("Approver", "Согласующий", "Aprobador"),
  },
  deal: {
    owner: label("Responsible", "Ответственный", "Responsable"),
    contact: label("Contact", "Контакт", "Contacto"),
    "decision-maker": label("Decision-maker", "Принимает решение", "Responsable de decidir"),
    influencer: label("Influencer", "Влияет на решение", "Influye en la decisión"),
  },
  contract: {
    customer: label("Customer", "Заказчик", "Cliente"),
    supplier: label("Supplier", "Поставщик", "Proveedor"),
    signatory: label("Signatory", "Подписант", "Firmante"),
    guarantor: label("Guarantor", "Поручитель", "Garante"),
  },
  related: {
    colleague: label("Colleague", "Коллега", "Colega"),
    adviser: label("Adviser", "Советник", "Asesor"),
    investor: label("Investor", "Инвестор", "Inversor"),
    mentor: label("Mentor", "Наставник", "Mentor"),
    family: label("Family", "Семья", "Familia"),
    friend: label("Friend", "Друг", "Amigo"),
  },
}
